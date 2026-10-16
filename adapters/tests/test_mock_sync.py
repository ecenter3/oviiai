"""模擬器依後端轉接器設定增減機器人（T-25：新增機器人後模擬器即出現）"""
import asyncio

from common.bridge import Bridge
from mock.driver import MockDriver
from mock.run import driver_spec, plan_sync

DEFAULTS = {"B2-001": {"code": "B2-001", "floor": "1f", "x": 2, "y": 2, "battery": 85, "speed": 1.2, "dock": {"x": 1, "y": 1}}}


def test_known_robot_uses_yaml_defaults_but_backend_floor():
    spec = driver_spec({"code": "B2-001", "floor": "2f", "chargers": []}, DEFAULTS)
    assert spec["x"] == 2 and spec["battery"] == 85 and spec["floor"] == "2f"


def test_new_robot_placed_next_to_its_charger():
    spec = driver_spec({"code": "B2-003", "floor": "1f", "chargers": [{"x": 1, "y": 3}]}, DEFAULTS)
    assert spec == {"code": "B2-003", "floor": "1f", "x": 3.0, "y": 3.0, "battery": 80, "speed": 1.0, "dock": {"x": 1.0, "y": 3.0}}
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
