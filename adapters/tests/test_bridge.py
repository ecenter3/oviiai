"""Bridge 的指令流程：rejected / accepted -> done / failed、取代舊指令、遙控逾時。不需 MQTT broker。"""
import asyncio
import json

import pytest

from common import bridge as bridge_mod
from common.bridge import Bridge
from common.contracts import now_ms
from mock.driver import MockDriver


class Recorder(Bridge):
    def __init__(self, drivers):
        super().__init__("test", "0", drivers, "mqtt://localhost:1883")
        self.sent: list[tuple[str, dict]] = []

    async def publish(self, topic, payload, qos=0, retain=False):
        self.sent.append((topic, json.loads(payload)))

    def acks(self):
        return [(m["cmdId"], m["status"], (m.get("error") or {}).get("code")) for t, m in self.sent
                if t.endswith("/ack")]


def cmd(cid, type_, **args):
    return json.dumps({"cmdId": cid, "ts": now_ms(), "type": type_, "args": args})


@pytest.fixture
async def setup():
    d = MockDriver("B2-001", "1F", speed=20)
    await d.connect()
    b = Recorder([d])
    yield b, d
    await d.close()


async def test_rejected_when_unsupported(setup):
    b, _ = setup
    await b.on_message("rms/robot/B2-001/cmd", cmd("c1", "lift", height=100))
    assert b.acks() == [("c1", "rejected", "UNSUPPORTED")]


async def test_accepted_then_done(setup):
    b, d = setup
    await b.on_message("rms/robot/B2-001/cmd", cmd("c1", "navigate", x=3, y=0))
    await asyncio.wait_for(b._running["B2-001"], 2)
    assert b.acks() == [("c1", "accepted", None), ("c1", "done", None)]
    assert d.x == pytest.approx(3, abs=0.06)


async def test_new_move_supersedes_old(setup):
    b, d = setup
    d.max_speed = 0.5
    await b.on_message("rms/robot/B2-001/cmd", cmd("c1", "navigate", x=50, y=0))
    await asyncio.sleep(0.05)
    await b.on_message("rms/robot/B2-001/cmd", cmd("c2", "stop"))
    await asyncio.wait_for(b._running["B2-001"], 2)
    await asyncio.sleep(0.05)
    assert ("c1", "failed", "CANCELLED") in b.acks()
    assert ("c2", "done", None) in b.acks()


async def test_robot_not_connected_is_rejected():
    d = MockDriver("B2-002", "1F")
    b = Recorder([d])
    await b.on_message("rms/robot/B2-002/cmd", cmd("c1", "navigate", x=1, y=1))
    assert b.acks() == [("c1", "rejected", "OFFLINE")]


async def test_teleop_watchdog_stops_robot(setup, monkeypatch):
    b, d = setup
    monkeypatch.setattr(bridge_mod, "TELEOP_TIMEOUT_S", 0.2)
    wd = asyncio.create_task(b._teleop_watchdog())
    t = json.dumps({"lockId": "L", "vx": 1.0, "vy": 0, "wz": 0, "ts": now_ms()})
    await b.on_message("rms/robot/B2-001/teleop", t)
    assert d.state == "teleop"
    await asyncio.sleep(0.5)
    assert d.state == "idle" and d._vel == (0.0, 0.0, 0.0)
    wd.cancel()


async def test_teleop_ignored_while_estopped(setup):
    """PR #4 審查第 1 點：急停中收到遙控速度，轉接器不得讓機器人移動"""
    b, d = setup
    await b.on_message("rms/robot/B2-001/cmd", cmd("c1", "estop"))
    await asyncio.wait_for(b._running["B2-001"], 2)
    assert d.state == "estop"
    t = json.dumps({"lockId": "L", "vx": 1.0, "vy": 0, "wz": 0, "ts": now_ms()})
    await b.on_message("rms/robot/B2-001/teleop", t)
    x0 = d.x
    await asyncio.sleep(0.3)
    assert d.state == "estop"
    assert d._vel == (0.0, 0.0, 0.0)
    assert d.x == x0
    assert "B2-001" not in b._teleop_deadline


async def test_estop_during_teleop_stops_motion(setup):
    b, d = setup
    t = json.dumps({"lockId": "L", "vx": 1.0, "vy": 0, "wz": 0, "ts": now_ms()})
    await b.on_message("rms/robot/B2-001/teleop", t)
    assert d.state == "teleop"
    await b.on_message("rms/robot/B2-001/cmd", cmd("c1", "estop"))
    await asyncio.wait_for(b._running["B2-001"], 2)
    assert d.state == "estop" and d._vel == (0.0, 0.0, 0.0)
    await b.on_message("rms/robot/B2-001/teleop", t)
    assert d.state == "estop"


async def test_mock_driver_refuses_teleop_when_estopped(setup):
    """driver 自己也擋（bridge 之外的第二道）"""
    from common.contracts import Teleop
    from common.driver import CommandError

    _, d = setup
    d.state = "estop"
    with pytest.raises(CommandError) as e:
        await d.teleop(Teleop(lockId="L", vx=1, vy=0, wz=0, ts=now_ms()))
    assert e.value.code == "ESTOP"


async def test_pause_holds_navigation_and_resume_continues(setup):
    """PR #6 審查第 2 點：pause 停在原地、指令不結束；resume 接續原本的導航並以原 cmdId 回 done"""
    b, d = setup
    d.max_speed = 2.0
    await b.on_message("rms/robot/B2-001/cmd", cmd("nav", "navigate", x=3, y=0))
    await asyncio.sleep(0.3)
    await b.on_message("rms/robot/B2-001/cmd", cmd("p", "pause"))
    await asyncio.wait_for(asyncio.gather(*b._side), 1)
    x_paused = d.x
    assert d.state == "paused" and 0 < x_paused < 3
    await asyncio.sleep(0.4)
    assert d.x == pytest.approx(x_paused)          # 停在原地
    assert ("nav", "done", None) not in b.acks()  # 導航指令還沒結束

    await b.on_message("rms/robot/B2-001/cmd", cmd("r", "resume"))
    await asyncio.sleep(0.05)
    assert d.state == "navigating"
    await asyncio.wait_for(b._running["B2-001"], 3)
    assert ("nav", "done", None) in b.acks()
    assert d.x == pytest.approx(3, abs=0.06)


async def test_teleop_during_pause_then_resume_continues_from_new_position(setup):
    b, d = setup
    d.max_speed = 2.0
    await b.on_message("rms/robot/B2-001/cmd", cmd("nav", "navigate", x=3, y=0))
    await asyncio.sleep(0.2)
    await b.on_message("rms/robot/B2-001/cmd", cmd("p", "pause"))
    await asyncio.wait_for(asyncio.gather(*b._side), 1)
    t = json.dumps({"lockId": "L", "vx": 0, "vy": 1.0, "wz": 0, "ts": now_ms()})
    await b.on_message("rms/robot/B2-001/teleop", t)
    await asyncio.sleep(0.3)
    assert d.state == "teleop" and d.y > 0.1
    await d.stop_motion()
    assert d.state == "paused"                     # 遙控結束回到暫停（導航仍在）
    await b.on_message("rms/robot/B2-001/cmd", cmd("r", "resume"))
    await asyncio.wait_for(b._running["B2-001"], 3)
    assert ("nav", "done", None) in b.acks()
    assert (d.x, d.y) == (pytest.approx(3, abs=0.06), pytest.approx(0, abs=0.06))


async def test_new_navigate_after_pause_supersedes_old(setup):
    """pause 不取代目前導航；之後的 navigate 會取消舊導航（舊的回 CANCELLED），不會兩個同時跑"""
    b, d = setup
    d.max_speed = 2.0
    await b.on_message("rms/robot/B2-001/cmd", cmd("old", "navigate", x=3, y=0))
    await asyncio.sleep(0.2)
    await b.on_message("rms/robot/B2-001/cmd", cmd("p", "pause"))
    await asyncio.wait_for(asyncio.gather(*b._side), 1)
    await b.on_message("rms/robot/B2-001/cmd", cmd("new", "navigate", x=0, y=2))
    await asyncio.wait_for(b._running["B2-001"], 3)
    await asyncio.sleep(0.05)
    assert ("old", "failed", "CANCELLED") in b.acks()
    assert ("new", "done", None) in b.acks()
    assert (d.x, d.y) == (pytest.approx(0, abs=0.06), pytest.approx(2, abs=0.06))


async def test_side_commands_keep_strong_reference_until_done(setup):
    """PR #7 審查第 1 點：同一台連續兩個非移動指令，前一個不會因參考被覆蓋而遺失"""
    b, d = setup
    await b.on_message("rms/robot/B2-001/cmd", cmd("s1", "snapshot"))
    await b.on_message("rms/robot/B2-001/cmd", cmd("s2", "snapshot"))
    assert len(b._side) == 2
    await asyncio.wait_for(asyncio.gather(*list(b._side)), 1)
    await asyncio.sleep(0)
    assert b._side == set()
    assert ("s1", "done", None) in b.acks() and ("s2", "done", None) in b.acks()


async def test_teleop_watchdog_default_500ms(setup):
    """T-30 驗收「斷訊 500 ms 停車」：用預設值，0.35 秒時還在動，0.7 秒內停下"""
    b, d = setup
    assert bridge_mod.TELEOP_TIMEOUT_S == 0.5
    wd = asyncio.create_task(b._teleop_watchdog())
    t = json.dumps({"lockId": "L", "vx": 0.5, "vy": 0, "wz": 0, "ts": now_ms()})
    await b.on_message("rms/robot/B2-001/teleop", t)
    await asyncio.sleep(0.35)
    assert d.state == "teleop" and d._vel[0] == 0.5
    await asyncio.sleep(0.35)
    assert d.state == "idle" and d._vel == (0.0, 0.0, 0.0)
    wd.cancel()


async def test_set_params_stored_and_limits_teleop_speed(setup):
    """T-27：set_params 由共通層處理（每個品牌都接受），遙控平移速度不超過「導航速度」"""
    b, d = setup
    await b.on_message("rms/robot/B2-001/cmd", cmd("p1", "set_params", params={"walk": {"speed": 0.6}, "video": {}, "talk": {}, "ext": {}}))
    await asyncio.wait_for(asyncio.gather(*list(b._side)), 1)
    assert ("p1", "done", None) in b.acks()
    assert d.speed_limit() == 0.6
    done = next(m for t, m in b.sent if t.endswith("/ack") and m["cmdId"] == "p1" and m["status"] == "done")
    # PR #13 審查第 2 點：ack 帶已套用／不支援的項目；mock 的導航速度也跟著降
    assert done["result"] == {"applied": ["walk.speed"], "ignored": []}
    assert d.max_speed == 0.6
    await b.on_message("rms/robot/B2-001/teleop", json.dumps({"lockId": "L", "vx": 1.2, "vy": 1.6, "wz": 2.0, "ts": now_ms()}))
    vx, vy, wz = d._vel
    assert (vx, vy) == (pytest.approx(0.36), pytest.approx(0.48)) and wz == 2.0  # 方向不變、等比例縮到 0.6
    await b.on_message("rms/robot/B2-001/teleop", json.dumps({"lockId": "L", "vx": 0.3, "vy": 0, "wz": 0, "ts": now_ms()}))
    assert d._vel == (0.3, 0, 0)  # 沒超過不動
    await b.on_message("rms/robot/B2-001/cmd", cmd("p2", "set_params"))
    assert ("p2", "rejected", "BAD_ARGS") in b.acks()


async def test_mock_ptz_light_follow(setup):
    b, d = setup
    await b.on_message("rms/robot/B2-001/cmd", cmd("a", "ptz", pan=-0.25, tilt=0.1, zoom=0))
    await b.on_message("rms/robot/B2-001/cmd", cmd("b", "light", on=True, mode="fill"))
    await b.on_message("rms/robot/B2-001/cmd", cmd("c", "follow", personId="P-001"))
    await asyncio.wait_for(asyncio.gather(*list(b._side)), 1)
    assert d.ptz == (-0.25, 0.1, 0.0) and d.lights == {"fill": True} and d.following == "P-001"
    await b.on_message("rms/robot/B2-001/cmd", cmd("d", "follow_stop"))
    await asyncio.wait_for(asyncio.gather(*list(b._side)), 1)
    assert d.following is None


async def test_set_params_reports_ignored_items(setup):
    b, d = setup
    params = {"walk": {"speed": 0.8, "collide": "safe"}, "video": {"stream": "normal"}, "talk": {}, "ext": {}}
    await b.on_message("rms/robot/B2-001/cmd", cmd("p1", "set_params", params=params))
    await asyncio.wait_for(asyncio.gather(*list(b._side)), 1)
    done = next(m for t, m in b.sent if t.endswith("/ack") and m["status"] == "done")
    assert done["result"] == {"applied": ["walk.speed"], "ignored": ["walk.collide", "video.stream"]}
