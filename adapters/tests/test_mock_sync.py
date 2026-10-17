"""模擬器依後端轉接器設定增減機器人（T-25：新增機器人後模擬器即出現）"""
import asyncio

from common.bridge import Bridge
from common.transform import Affine2D
from mock.driver import MockDriver
from mock.run import driver_spec, plan_sync

DEFAULTS = {"B2-001": {"code": "B2-001", "floor": "1f", "x": 2, "y": 2, "battery": 85, "speed": 1.2, "dock": {"x": 1, "y": 1}}}


def test_known_robot_uses_yaml_defaults_but_backend_floor():
    spec = driver_spec({"code": "B2-001", "floor": "2f", "chargers": []}, DEFAULTS)
    assert spec["x"] == 2 and spec["battery"] == 85 and spec["floor"] == "2f"


def test_new_robot_placed_next_to_its_charger():
    spec = driver_spec({"code": "B2-003", "floor": "1f", "chargers": [{"x": 1, "y": 3}]}, DEFAULTS)
    assert spec == {"code": "B2-003", "floor": "1f", "x": 3.0, "y": 3.0, "battery": 80, "speed": 1.0, "dock": {"x": 1.0, "y": 3.0}, "to_robot": Affine2D()}
    MockDriver(**spec)  # 參數 MockDriver 都接受


def test_plan_sync_adds_new_and_removes_disabled():
    add, remove = plan_sync({"B2-001", "B2-002"}, [{"code": "B2-001", "floor": "1f"}, {"code": "B2-003", "floor": "1f", "chargers": []}], DEFAULTS)
    assert [a["code"] for a in add] == ["B2-003"]
    assert remove == ["B2-002"]


def test_bridge_add_remove_without_mqtt():
    async def go():
        b = Bridge("mock", "t", [], "mqtt://localhost:1")
        d = MockDriver(code="X-1", floor="1f")
        await b.add_driver(d)
        assert "X-1" in b.drivers
        await b.add_driver(MockDriver(code="X-1", floor="1f"))  # 重複不加
        assert b.drivers["X-1"] is d
        await b.remove_driver("X-1")
        assert b.drivers == {}
        await b.remove_driver("X-1")
    asyncio.run(go())


# ---- 座標校正同步（PR #11 審查第 2 點）----
from common.config_sync import request_calibrations  # noqa: E402
from common.contracts import Command, now_ms  # noqa: E402

#: 後端存的校正：機器人地圖 → 平台 平移 (+10, -2)
CALIB = {"mapId": "1f", "matrix": [1, 0, 10, 0, 1, -2]}


def test_saved_calibration_changes_next_telemetry_when_idle():
    async def go():
        d = MockDriver(code="B2-009", floor="1f", x=5, y=5)
        d.last_state = "idle"
        before = (await d.read_telemetry()).pose
        assert (before.x, before.y) == (5, 5)
        assert request_calibrations({"B2-009": d}, [{"code": "B2-009", "calib": CALIB}]) == ["B2-009"]
        assert d.apply_pending_transform() is True
        after = (await d.read_telemetry()).pose
        # 機器人實際沒動（地圖座標仍是 5,5），平台座標照新校正換算
        assert (after.x, after.y) == (15, 3)
        # 同樣的校正再同步一次不算變更
        assert request_calibrations({"B2-009": d}, [{"code": "B2-009", "calib": CALIB}]) == []
    asyncio.run(go())


def test_calibration_waits_while_moving_and_applies_at_next_move_command():
    async def go():
        b = Bridge("mock", "t", [], "mqtt://localhost:1")
        d = MockDriver(code="B2-010", floor="1f", x=0, y=0, speed=1000)
        await b.add_driver(d)
        await d.connect()
        d.last_state = "navigating"
        d.request_transform(Affine2D.to_robot_from_calib(CALIB))
        assert d.apply_pending_transform() is False  # 導航中不換
        assert d.pending_transform is not None
        # 下一個 navigate 開始前一定換成新校正：平台 (12, 0) → 地圖 (2, 2)
        await b._run_cmd(d, Command(cmdId="c1", ts=now_ms(), type="navigate", args={"x": 12, "y": 0}))
        assert d.pending_transform is None
        assert (round(d.x, 1), round(d.y, 1)) == (2.0, 2.0)
        p = (await d.read_telemetry()).pose
        assert (round(p.x, 1), round(p.y, 1)) == (12.0, 0.0)
        await d.close()
    asyncio.run(go())
