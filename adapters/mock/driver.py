"""模擬機器人：沒有真機時開發後端與前端用。

會移動到目標點、耗電、充電、支援遙控；可設定 fail_rate 模擬導航失敗。
pause 讓導航停在原地（指令仍在執行），resume 從目前位置接續原本的導航——與真機（X30 等）一致。
"""
from __future__ import annotations

import asyncio
import math
import random
from typing import Any

from common.contracts import Battery, Command, Pose, RobotEvent, Telemetry, Teleop, now_ms
from common.driver import CommandError, RobotDriver, split_params
from common.transform import Affine2D

TICK_S = 0.1


class MockDriver(RobotDriver):
    capabilities = frozenset({"navigate", "patrol", "stop", "pause", "resume", "charge", "estop",
                              "estop_release", "snapshot", "ptz", "light", "follow", "follow_stop"})

    def __init__(self, code: str, floor: str, x: float = 0.0, y: float = 0.0, battery: float = 80.0,
                 speed: float = 1.0, dock: dict[str, float] | None = None, fail_rate: float = 0.0,
                 teleop: bool = True, drain_per_m: float = 0.05, charge_rate: float = 0.5,
                 to_robot: Affine2D | None = None):
        super().__init__(code, floor, to_robot)
        # 模擬器在「機器人地圖座標」裡移動，回報時換成平台座標（與真機轉接器相同）；
        # 參數給的初始位置是平台座標
        self.x, self.y = self.to_robot.apply(x, y)
        self.yaw = 0.0
        self.battery = battery
        self.max_speed = speed
        #: 設定檔的最高速度；參數「導航速度」只能往下調
        self.base_speed = speed
        self.dock = dock or {"x": x, "y": y}
        self.fail_rate = fail_rate
        self.drain_per_m = drain_per_m
        #: 充電速度（%／秒）；測試排隊情境可調快
        self.charge_rate = charge_rate
        self.state = "idle"
        self.speed = 0.0
        self._connected = False
        self._vel = (0.0, 0.0, 0.0)
        self._loop_task: asyncio.Task | None = None
        # 導航進行中時的狀態（navigating／patrolling／returning）；None 表示沒有導航
        self._goal_state: str | None = None
        # 清除＝暫停：導航迴圈停在原地等待 resume
        self._go = asyncio.Event()
        self._go.set()
        #: 雲台位置（正規化 -1..1，絕對位置）、燈光（mode → 開關）、跟隨對象；只記錄，供測試與日誌
        self.ptz = (0.0, 0.0, 0.0)
        self.lights: dict[str, bool] = {}
        self.following: str | None = None
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
                self.battery = min(100.0, self.battery + self.charge_rate * TICK_S)
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
        px, py = self.to_platform.apply(self.x, self.y)
        return Telemetry(
            ts=now_ms(),
            pose=Pose(x=round(px, 3), y=round(py, 3), yaw=round(self.to_platform.apply_yaw(self.yaw), 3), floor=self.floor),
            battery=Battery(pct=round(self.battery, 1), charging=self.state == "charging"),
            state=self.state, speed=round(self.speed, 2), taskRef=self.task_ref,
        )

    async def validate(self, cmd: Command) -> None:
        await super().validate(cmd)
        if self.state == "estop" and cmd.type not in {"estop_release", "stop"}:
            raise CommandError("ESTOP", "robot is in emergency stop")

    async def _goto(self, gx: float, gy: float, state: str) -> None:
        self.state = state
        self._goal_state = state
        try:
            while True:
                if not self._go.is_set():
                    self.speed = 0.0
                    await self._go.wait()
                    self.state = state
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
            self._goal_state = None
        if random.random() < self.fail_rate:
            raise CommandError("MOCK_NAV_FAILED", "simulated navigation failure")

    async def execute(self, cmd: Command) -> dict[str, Any] | None:
        t = cmd.type
        if t == "pause":
            # 導航停在原地，指令不結束；沒有導航時只是標成暫停
            self._go.clear()
            self.speed = 0.0
            self.state = "paused"
            return None
        if t == "resume":
            self._go.set()
            self.state = self._goal_state or "idle"
            return None
        if t == "stop":
            self._go.set()
            self.state = "idle"
            return None
        if t == "estop":
            self._go.set()
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
        if t == "ptz":
            self.ptz = (float(cmd.args["pan"]), float(cmd.args["tilt"]), float(cmd.args["zoom"]))
            return None
        if t == "light":
            self.lights[str(cmd.args.get("mode") or "default")] = bool(cmd.args["on"])
            return None
        if t == "follow":
            self.following = str(cmd.args["personId"])
            return None
        if t == "follow_stop":
            self.following = None
            return None

        self.task_ref = cmd.cmdId
        self._go.set()  # 新的移動指令取代暫停中的舊導航
        try:
            if t == "navigate":
                await self._goto(*self.to_robot.apply(float(cmd.args["x"]), float(cmd.args["y"])), "navigating")
                self.emit(RobotEvent(ts=now_ms(), type="goal_reached", data={"cmdId": cmd.cmdId}))
            elif t == "patrol":
                for i, pt in enumerate(cmd.args.get("points", [])):
                    await self._goto(*self.to_robot.apply(float(pt["x"]), float(pt["y"])), "patrolling")
                    self.emit(RobotEvent(ts=now_ms(), type="waypoint_reached", data={"cmdId": cmd.cmdId, "index": i}))
            elif t == "charge":
                # 後端排程指定充電樁時帶座標；沒帶就回自己設定的充電點
                gx = float(cmd.args.get("x", self.dock["x"]))
                gy = float(cmd.args.get("y", self.dock["y"]))
                await self._goto(*self.to_robot.apply(gx, gy), "returning")
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

    async def apply_params(self, params: dict[str, Any]) -> dict[str, list[str]]:
        """模擬器：導航速度也套用到導航（真機要品牌 driver 實作才會生效），其他項目不支援"""
        limit = self.speed_limit()
        self.max_speed = min(self.base_speed, limit) if limit else self.base_speed
        return split_params(params, {"walk.speed"})

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
            # 遙控前有暫停中的導航：回到暫停，等 resume 或新指令
            self.state = "paused" if self._goal_state and not self._go.is_set() else "idle"
