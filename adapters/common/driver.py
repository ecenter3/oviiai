"""每個品牌實作一個 RobotDriver；MQTT 細節由 bridge 處理，driver 只管和機器人溝通。"""
from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from typing import Any

from .contracts import Command, RobotEvent, Telemetry, Teleop
from .transform import Affine2D


class CommandError(Exception):
    """指令執行失敗。code 會原樣放進 ack.error.code。"""

    def __init__(self, code: str, msg: str):
        super().__init__(f"{code}: {msg}")
        self.code = code
        self.msg = msg


class RobotDriver(ABC):
    #: 這個品牌支援的指令（後端與前端依此顯示按鈕，不做品牌判斷）
    capabilities: frozenset[str] = frozenset()

    def __init__(self, code: str, floor: str, to_robot: Affine2D | None = None):
        self.code = code
        self.floor = floor
        self.to_robot = to_robot or Affine2D()      # 平台座標 -> 機器人地圖座標
        self.to_platform = self.to_robot.inverse()  # 機器人地圖座標 -> 平台座標
        self.events: asyncio.Queue[RobotEvent] = asyncio.Queue()
        self.task_ref: str | None = None

    # ---- 生命週期 ----
    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...

    @property
    @abstractmethod
    def connected(self) -> bool: ...

    # ---- 狀態 ----
    @abstractmethod
    async def read_telemetry(self) -> Telemetry:
        """約 1 Hz 呼叫一次。座標必須已轉成平台座標。"""

    # ---- 指令 ----
    async def validate(self, cmd: Command) -> None:
        """在回 accepted 之前呼叫；不能執行就 raise CommandError（回 rejected）。"""
        if cmd.type not in self.capabilities:
            raise CommandError("UNSUPPORTED", f"{self.code} does not support '{cmd.type}'")

    @abstractmethod
    async def execute(self, cmd: Command) -> dict[str, Any] | None:
        """執行到完成才 return（回 done）；失敗 raise CommandError（回 failed）。"""

    async def teleop(self, t: Teleop) -> None:
        raise CommandError("UNSUPPORTED", "teleop not supported")

    async def stop_motion(self) -> None:
        """遙控逾時（500 ms）時呼叫，必須讓機器人停下。"""

    def emit(self, ev: RobotEvent) -> None:
        self.events.put_nowait(ev)
