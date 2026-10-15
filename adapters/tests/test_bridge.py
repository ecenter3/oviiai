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
    await b.on_message("rms/robot/B2-001/cmd", cmd("c1", "ptz"))
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
