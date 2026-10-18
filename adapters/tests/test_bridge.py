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


# ---- 雙向對講（T-31）----
def _pcm(seconds: float, amp: int) -> bytes:
    import math
    import struct
    n = int(16000 * seconds)
    return struct.pack(f"<{n}h", *(int(amp * math.sin(2 * math.pi * 440 * i / 16000)) for i in range(n)))


async def test_mock_talk_records_seconds_and_level(setup):
    """方案 A：模擬器不播放，收到音訊就記錄秒數與音量"""
    _, d = setup
    d.talk = {"seconds": 0, "bytes": 0, "peak_db": -90.0}
    reader = asyncio.StreamReader()
    reader.feed_data(_pcm(1.0, 3000) + _pcm(1.2, 16000))
    reader.feed_eof()
    await d.consume_talk(reader)
    assert d.talk["seconds"] == 2  # 不滿 1 秒的尾巴不算
    assert -10 < d.talk["peak_db"] < 0


async def test_talk_start_stop_via_bridge(setup, monkeypatch):
    b, d = setup
    monkeypatch.setenv("FFMPEG_PATH", "")
    monkeypatch.setattr("shutil.which", lambda _n: None)  # 沒有 ffmpeg：只記錄開始與結束
    await b.on_message("rms/robot/B2-001/cmd", cmd("t1", "talk_start", url="rtsp://127.0.0.1:8554/talk/B2-001", user="talk", token="tok"))
    await asyncio.wait_for(asyncio.gather(*list(b._side)), 1)
    assert ("t1", "done", None) in b.acks() and d.talk is not None
    await b.on_message("rms/robot/B2-001/cmd", cmd("t2", "talk_stop"))
    await asyncio.wait_for(asyncio.gather(*list(b._side)), 1)
    assert ("t2", "done", None) in b.acks() and d.talk is None
    await b.on_message("rms/robot/B2-001/cmd", cmd("t3", "talk_start", url="rtsp://x/talk/B2-001"))
    assert ("t3", "rejected", "BAD_ARGS") in b.acks()


def test_talk_url_puts_token_in_userinfo_and_resolves_host():
    from mock.driver import talk_url
    u = talk_url("rtsp://localhost:8554/talk/B2-001", "talk", "a.b/c=")
    assert u == "rtsp://talk:a.b%2Fc%3D@127.0.0.1:8554/talk/B2-001"


async def test_mock_speak_text_and_audio(setup):
    """方案 B：音檔從預簽名網址下載（PR #15 審查第 1 點）；文字語音只記錄"""
    import http.server
    import threading

    body = b"\x1a\x45\xdf\xa3" * 100

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        b, d = setup
        url = f"http://127.0.0.1:{srv.server_port}/rms/speak/x.webm?sig=1"
        await b.on_message("rms/robot/B2-001/cmd", cmd("s1", "speak", audio={"url": url, "mime": "audio/webm", "bytes": 400, "durationMs": 2500}))
        await b.on_message("rms/robot/B2-001/cmd", cmd("s2", "speak", text="請離開管制區"))
        await asyncio.wait_for(asyncio.gather(*list(b._side)), 3)
        # 下載比文字慢，完成順序不一定
        assert sorted(d.spoken, key=lambda x: x["kind"]) == [
            {"kind": "audio", "mime": "audio/webm", "bytes": 400, "durationMs": 2500},
            {"kind": "text", "text": "請離開管制區"},
        ]
        # 下載失敗（網址過期、連不上）回 failed
        await b.on_message("rms/robot/B2-001/cmd", cmd("s3", "speak", audio={"url": "http://127.0.0.1:1/x", "mime": "audio/webm"}))
        await asyncio.wait_for(asyncio.gather(*list(b._side)), 5)
        assert ("s3", "failed", "DOWNLOAD_FAILED") in b.acks()
        await b.on_message("rms/robot/B2-001/cmd", cmd("s4", "speak", audio={"data": "AAAA"}))
        assert ("s4", "rejected", "BAD_ARGS") in b.acks()
    finally:
        srv.shutdown()


def test_download_size_limit():
    import http.server
    import threading

    from common.driver import CommandError
    from mock.driver import download

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"x" * 2048)

        def log_message(self, *_a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        with pytest.raises(CommandError) as e:
            download(f"http://127.0.0.1:{srv.server_port}/x", limit=1024)
        assert e.value.code == "TOO_LARGE"
        with pytest.raises(CommandError):
            download("file:///etc/passwd")
    finally:
        srv.shutdown()


async def test_mock_talk_reports_failure_when_stream_breaks(setup, monkeypatch, tmp_path):
    """PR #15 審查第 3 點：拉流失敗或中斷（沒有 talk_stop）→ talk_failed 事件"""
    _, d = setup
    fake = tmp_path / "ffmpeg"
    fake.write_text("#!/bin/sh\necho 'Server returned 401 Unauthorized (authorization failed)' >&2\nexit 1\n")
    fake.chmod(0o755)
    monkeypatch.setenv("FFMPEG_PATH", str(fake))
    d.talk = {"seconds": 0, "bytes": 0, "peak_db": -90.0}
    await d._talk_rx("rtsp://talk:tok@127.0.0.1:8554/talk/B2-001")
    ev = d.events.get_nowait()
    assert ev.type == "talk_failed" and "401" in ev.data["reason"]


async def test_mock_show_image_and_upload_logs(setup):
    """T-42：警示圖從預簽名網址下載後顯示；日誌 PUT 到後端給的預簽名網址"""
    import http.server
    import threading

    img = b"\x89PNG" + b"\x00" * 200
    uploaded: dict[str, bytes] = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Length", str(len(img)))
            self.end_headers()
            self.wfile.write(img)

        def do_PUT(self):  # noqa: N802
            uploaded[self.path] = self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *_a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        b, d = setup
        base = f"http://127.0.0.1:{srv.server_port}"
        await b.on_message("rms/robot/B2-001/cmd", cmd("i1", "show_image", image={"url": f"{base}/a.png?sig=1", "mime": "image/png", "bytes": 204}, seconds=30))
        await b.on_message("rms/robot/B2-001/cmd", cmd("l1", "upload_logs", subsystem="motion", url=f"{base}/robot-logs/x.log?sig=1"))
        await asyncio.wait_for(asyncio.gather(*list(b._side)), 3)
        assert d.screen == {"mime": "image/png", "bytes": 204, "seconds": 30}
        assert uploaded["/robot-logs/x.log?sig=1"].startswith(b"# B2-001 motion log")
        assert ("i1", "done", None) in b.acks() and ("l1", "done", None) in b.acks()
        await b.on_message("rms/robot/B2-001/cmd", cmd("l2", "upload_logs", subsystem="kernel", url=f"{base}/x"))
        assert ("l2", "rejected", "BAD_ARGS") in b.acks()
        await b.on_message("rms/robot/B2-001/cmd", cmd("l3", "upload_logs", subsystem="video", url="http://127.0.0.1:1/x"))
        await asyncio.wait_for(asyncio.gather(*list(b._side)), 5)
        assert ("l3", "failed", "UPLOAD_FAILED") in b.acks()
        # 超過後端給的上限：不傳，回報失敗
        await b.on_message("rms/robot/B2-001/cmd", cmd("l4", "upload_logs", subsystem="motion", url=f"{base}/robot-logs/y.log", maxBytes=10))
        await asyncio.wait_for(asyncio.gather(*list(b._side)), 3)
        assert ("l4", "failed", "TOO_LARGE") in b.acks() and "/robot-logs/y.log" not in uploaded
    finally:
        srv.shutdown()
