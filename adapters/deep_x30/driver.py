"""X30 RobotDriver。

指令對應：
- navigate {x, y, yaw?}           -> 1003 單點（平台座標轉機器人地圖座標）
- patrol   {points:[{x,y,yaw?}]}  -> 1003 多點
- stop / pause                    -> 1004
- charge                          -> 尚無 SDK 指令；若設定了 dock_point 就導航到充電樁前（待原廠確認）
遙控、影像、PTZ 目前 SDK 不支援。
"""
from __future__ import annotations

import asyncio
from typing import Any

from common.contracts import Battery, Command, Fault, Pose, RobotEvent, Telemetry, now_ms
from common.driver import CommandError, RobotDriver
from common.transform import Affine2D

from . import protocol as p
from .client import X30Client


class X30Driver(RobotDriver):
    capabilities = frozenset({"navigate", "patrol", "stop", "pause"})

    def __init__(self, code: str, floor: str, host: str, port: int = 30000,
                 to_robot: Affine2D | None = None, nav_defaults: dict[str, int] | None = None,
                 dock_point: dict[str, float] | None = None):
        super().__init__(code, floor, to_robot)
        self.client = X30Client(host, port)
        self.nav_defaults = {"navMode": 1, "speed": 0, "gait": 0, "obsMode": 0, **(nav_defaults or {})}
        self.dock_point = dock_point
        if dock_point:
            self.capabilities = self.capabilities | {"charge"}
        self._busy = False
        self._last_fault: int | None = None

    @property
    def connected(self) -> bool:
        return self.client.connected

    async def connect(self) -> None:
        await self.client.connect()

    async def close(self) -> None:
        await self.client.close()

    # ---------------------------------------------------------------- telemetry
    async def read_telemetry(self) -> Telemetry:
        s = await self.client.get_status()
        x, y = self.to_platform.apply(s.posX, s.posY)
        faults: list[Fault] = []
        if s.location != 0:
            faults.append(Fault(code="X30_LOCALIZATION_LOST", level=2, msg="定位丟失"))
        if s.motorState != 0:
            faults.append(Fault(code=f"X30_MOTOR_{s.motorState}", level=2, msg="電機狀態異常"))
        charging = s.chargeState != 0
        if faults:
            state = "fault"
        elif charging:
            state = "charging"
        elif self._busy:
            state = "navigating"
        else:
            state = "idle"
        return Telemetry(
            ts=now_ms(),
            pose=Pose(x=x, y=y, yaw=self.to_platform.apply_yaw(s.angleYaw), floor=self.floor),
            battery=Battery(pct=max(0, min(100, s.electricity)), charging=charging),
            state=state, speed=abs(s.speed), taskRef=self.task_ref, faults=faults,
            sensors={"odom_total_m": {"value": s.sumOdom, "unit": "m"}},
        )

    # ---------------------------------------------------------------- commands
    def _to_nav_point(self, pt: dict[str, Any], value: int, task_point: bool) -> p.NavigationPoint:
        try:
            px, py = float(pt["x"]), float(pt["y"])
        except (KeyError, TypeError, ValueError) as e:
            raise CommandError("BAD_ARGS", f"point needs numeric x, y: {pt}") from e
        rx, ry = self.to_robot.apply(px, py)
        yaw = self.to_robot.apply_yaw(float(pt.get("yaw", 0.0)))
        return p.NavigationPoint(posX=rx, posY=ry, angleYaw=yaw, value=value,
                                 pointInfo=1 if task_point else 0, **self.nav_defaults)

    async def execute(self, cmd: Command) -> dict[str, Any] | None:
        if cmd.type in ("stop", "pause"):
            ok = await self.client.cancel_task()
            if not ok:
                raise CommandError("X30_CANCEL_FAILED", "1004 cancel returned error")
            return None
        if cmd.type == "navigate":
            points = [self._to_nav_point(cmd.args, 1, task_point=True)]
        elif cmd.type == "patrol":
            raw = cmd.args.get("points") or []
            if not raw:
                raise CommandError("BAD_ARGS", "patrol needs points")
            points = [self._to_nav_point(pt, i + 1, task_point=bool(pt.get("task", True)))
                      for i, pt in enumerate(raw)]
        elif cmd.type == "charge" and self.dock_point:
            points = [self._to_nav_point(self.dock_point, 1, task_point=True)]
        else:
            raise CommandError("UNSUPPORTED", cmd.type)
        return await self._run_route(cmd, points)

    async def _run_route(self, cmd: Command, points: list[p.NavigationPoint]) -> dict[str, Any]:
        self._busy, self.task_ref = True, cmd.cmdId
        try:
            res = await self.client.navigate(points)
        except asyncio.CancelledError:
            # 被新指令取代：通知機器人停止目前任務
            try:
                await self.client.cancel_task()
            finally:
                raise
        except ConnectionError as e:
            raise CommandError("X30_DISCONNECTED", str(e)) from e
        finally:
            self._busy, self.task_ref = False, None

        if res.errorCode == 0:
            self.emit(RobotEvent(ts=now_ms(), type="goal_reached", data={"cmdId": cmd.cmdId, "value": res.value}))
            return {"value": res.value}
        reason = p.ERROR_STATUS.get(res.errorStatus, f"未知錯誤 {res.errorStatus}")
        if res.errorStatus in p.FAULT_STATUSES:
            self.emit(RobotEvent(ts=now_ms(), type="fault", data={"code": f"X30_{res.errorStatus}", "msg": reason}))
        self.emit(RobotEvent(ts=now_ms(), type="goal_failed", data={"cmdId": cmd.cmdId, "status": res.errorStatus}))
        code = "X30_CANCELLED" if res.errorCode == 2 else f"X30_{res.errorStatus}"
        raise CommandError(code, reason)

