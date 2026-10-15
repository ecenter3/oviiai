import asyncio
import math

import pytest

from common.contracts import Command
from common.driver import CommandError
from common.transform import Affine2D
from deep_x30.client import X30Client
from deep_x30.driver import X30Driver

from .fake_x30 import FakeX30


@pytest.fixture
async def robot():
    srv = FakeX30()
    await srv.start()
    yield srv
    await srv.stop()


def cmd(type_, **args):
    return Command(cmdId=f"c-{type_}", ts=0, type=type_, args=args)


async def test_client_status_and_query(robot):
    c = X30Client("127.0.0.1", robot.port)
    await c.connect()
    s = await c.get_status()
    assert s.electricity == 76 and s.posX == 1.5
    q = await c.query_task()
    assert q.status == 1
    await c.close()


async def test_driver_telemetry_is_in_platform_coordinates(robot):
    # 機器人地圖 = 平台座標往 x 平移 10 m
    d = X30Driver("X30-001", "2F", "127.0.0.1", robot.port, to_robot=Affine2D(tx=10))
    await d.connect()
    t = await d.read_telemetry()
    assert t.pose.x == pytest.approx(1.5 - 10)
    assert t.pose.y == pytest.approx(-2.0)
    assert t.battery.pct == 76 and t.state == "idle" and t.pose.floor == "2F"
    await d.close()


async def test_navigate_sends_robot_coordinates_and_completes(robot):
    tf = Affine2D(a=0, b=-1, c=1, d=0, tx=5, ty=0)    # 旋轉 90 度 + 平移
    d = X30Driver("X30-001", "2F", "127.0.0.1", robot.port, to_robot=tf)
    await d.connect()
    res = await d.execute(cmd("navigate", x=1, y=2, yaw=0))
    assert res == {"value": 1}
    nav_body = [b for _, b in robot.received if "<Type>1003</Type>" in b][0]
    assert "<PosX>3</PosX>" in nav_body and "<PosY>1</PosY>" in nav_body   # (1,2) -> (-2+5, 1)
    assert f"<AngleYaw>{math.pi / 2:.6g}</AngleYaw>" in nav_body
    ev = await d.events.get()
    assert ev.type == "goal_reached"
    await d.close()


async def test_navigate_failure_maps_error_status(robot):
    robot.nav_error_status = 41747
    d = X30Driver("X30-001", "2F", "127.0.0.1", robot.port)
    await d.connect()
    with pytest.raises(CommandError) as e:
        await d.execute(cmd("navigate", x=1, y=1))
    assert e.value.code == "X30_41747"
    types = {(await d.events.get()).type, (await d.events.get()).type}
    assert types == {"fault", "goal_failed"}
    await d.close()


async def test_superseded_navigation_sends_cancel(robot):
    robot.nav_seconds = 5
    d = X30Driver("X30-001", "2F", "127.0.0.1", robot.port)
    await d.connect()
    task = asyncio.create_task(d.execute(cmd("navigate", x=1, y=1)))
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.wait_for(robot.cancelled.wait(), 1)
    await d.close()


async def test_unsupported_and_bad_args(robot):
    d = X30Driver("X30-001", "2F", "127.0.0.1", robot.port)
    with pytest.raises(CommandError) as e:
        await d.validate(cmd("charge"))
    assert e.value.code == "UNSUPPORTED"
    await d.connect()
    with pytest.raises(CommandError) as e:
        await d.execute(cmd("navigate", x="abc"))
    assert e.value.code == "BAD_ARGS"
    await d.close()
