"""模擬機器人：沒有真機時開發後端與前端用。

會移動到目標點、耗電、充電、支援遙控；可設定 fail_rate 模擬導航失敗。
"""
from __future__ import annotations

import asyncio
import math
import random
from typing import Any

from common.contracts import Battery, Command, Pose, RobotEvent, Telemetry, Teleop, now_ms
from common.driver import CommandError, RobotDriver

TICK_S = 0.1


class MockDriver(RobotDriver):
    capabilities = frozenset({"navigate", "patrol", "stop", "pause", "resume", "charge", "estop",
                              "estop_release", "snapshot"})

    def __init__(self, code: str, floor: str, x: float = 0.0, y: float = 0.0, battery: float = 80.0,
                 speed: float = 1.0, dock: dict[str, float] | None = None, fail_rate: float = 0.0,
                 teleop: bool = True, drain_per_m: float = 0.05):
        super().__init__(code, floor)
        self.x, self.y, self.yaw = x, y, 0.0
        self.battery = battery
        self.max_speed = speed
        self.dock = dock or {"x": x, "y": y}
        self.fail_rate = fail_rate
        self.drain_per_m = drain_per_m
        self.state = "idle"
        self.speed = 0.0
        self._connected = False
        self._vel = (0.0, 0.0, 0.0)
        self._loop_task: asyncio.Task | None = None
        if teleop:
            self.capabilities = self.capabilities | {"teleop"}

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self._connected = True
        self._loop_task = asyncio.create_task(self._physics())

    async def close(self) -> None:
        self._connected = False
        if self._loop_task:
            self._loop_task.cancel()

    async def _physics(self) -> None:
        while True:
            await asyncio.sleep(TICK_S)
            if self.state == "charging":
                self.battery = min(100.0, self.battery + 0.5 * TICK_S)
            elif self.state == "teleop":
                vx, vy, wz = self._vel
                self.yaw += wz * TICK_S
                dx = (vx * math.cos(self.yaw) - vy * math.sin(self.yaw)) * TICK_S
                dy = (vx * math.sin(self.yaw) + vy * math.cos(self.yaw)) * TICK_S
                self._advance(dx, dy)
            else:
                self.battery = max(0.0, self.battery - 0.002 * TICK_S)

    def _advance(self, dx: float, dy: float) -> None:
        self.x += dx
        self.y += dy
        dist = math.hypot(dx, dy)
        self.speed = dist / TICK_S
        self.battery = max(0.0, self.battery - dist * self.drain_per_m)

    async def read_telemetry(self) -> Telemetry:
        return Telemetry(
            ts=now_ms(),
            pose=Pose(x=round(self.x, 3), y=round(self.y, 3), yaw=round(self.yaw, 3), floor=self.floor),
            battery=Battery(pct=round(self.battery, 1), charging=self.state == "charging"),
            state=self.state, speed=round(self.speed, 2), taskRef=self.task_ref,
        )

    async def validate(self, cmd: Command) -> None:
        await super().validate(cmd)
        if self.state == "estop" and cmd.type not in {"estop_release", "stop"}:
            raise CommandError("ESTOP", "robot is in emergency stop")

    async def _goto(self, gx: float, gy: float, state: str) -> None:
        self.state = state
        try:
            while True:
                dx, dy = gx - self.x, gy - self.y
                dist = math.hypot(dx, dy)
                if dist < 0.05:
                    break
                step = min(dist, self.max_speed * TICK_S)
                self.yaw = math.atan2(dy, dx)
                self._advance(dx / dist * step, dy / dist * step)
                await asyncio.sleep(TICK_S)
                if self.battery <= 0:
                    raise CommandError("LOW_BATTERY", "battery depleted")
        finally:
            self.speed = 0.0
        if random.random() < self.fail_rate:
            raise CommandError("MOCK_NAV_FAILED", "simulated navigation failure")

    async def execute(self, cmd: Command) -> dict[str, Any] | None:
        t = cmd.type
        if t in ("stop", "pause"):
            self.state = "paused" if t == "pause" else "idle"
            return None
        if t == "resume":
            self.state = "idle"
            return None
        if t == "estop":
            self._vel = (0.0, 0.0, 0.0)
            self.speed = 0.0
            self.state = "estop"
            self.emit(RobotEvent(ts=now_ms(), type="estop_pressed"))
            return None
        if t == "estop_release":
            self.state = "idle"
            return None
        if t == "snapshot":
            return {"objectKey": f"mock/{self.code}/{cmd.cmdId}.jpg"}

        self.task_ref = cmd.cmdId
        try:
            if t == "navigate":
                await self._goto(float(cmd.args["x"]), float(cmd.args["y"]), "navigating")
                self.emit(RobotEvent(ts=now_ms(), type="goal_reached", data={"cmdId": cmd.cmdId}))
            elif t == "patrol":
                for i, pt in enumerate(cmd.args.get("points", [])):
                    await self._goto(float(pt["x"]), float(pt["y"]), "patrolling")
                    self.emit(RobotEvent(ts=now_ms(), type="waypoint_reached", data={"cmdId": cmd.cmdId, "index": i}))
            elif t == "charge":
                await self._goto(self.dock["x"], self.dock["y"], "returning")
                self.state = "charging"
                self.emit(RobotEvent(ts=now_ms(), type="charge_started"))
                return None
            self.state = "idle"
            return None
        except CommandError:
            self.state = "idle"
            self.emit(RobotEvent(ts=now_ms(), type="goal_failed", data={"cmdId": cmd.cmdId}))
            raise
        except asyncio.CancelledError:
            self.state = "idle"
            raise
        finally:
            self.task_ref = None

    def is_estopped(self) -> bool:
        return self.state == "estop"

    async def teleop(self, t: Teleop) -> None:
        if "teleop" not in self.capabilities:
            raise CommandError("UNSUPPORTED", "teleop not supported")
        if self.is_estopped():
            raise CommandError("ESTOP", "robot is in emergency stop")
        self.state = "teleop"
        self._vel = (t.vx, t.vy, t.wz)

    async def stop_motion(self) -> None:
        self._vel = (0.0, 0.0, 0.0)
        self.speed = 0.0
        if self.state == "teleop":
            self.state = "idle"
