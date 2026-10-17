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
        #: bridge 每次讀遙測後記下的狀態（判斷能不能換座標轉換）
        self.last_state: str | None = None
        self._pending: Affine2D | None = None

    # ---- 座標校正（後端 /adapter-config 的 calib；PR #11 審查第 2 點）----
    MOVING_STATES = frozenset({"navigating", "patrolling", "returning", "teleop"})

    def set_transform(self, to_robot: Affine2D) -> None:
        """立即換轉換（啟動時、或確定機器人沒在動時）"""
        self.to_robot = to_robot
        self.to_platform = to_robot.inverse()
        self._pending = None

    def request_transform(self, to_robot: Affine2D) -> None:
        """後端校正有變：先記著，等這台不在移動（或下一個移動指令開始）才換，
        避免導航途中換轉換、目標座標跳掉"""
        self._pending = None if to_robot == self.to_robot else to_robot

    @property
    def pending_transform(self) -> Affine2D | None:
        return self._pending

    def is_moving(self) -> bool:
        return self.last_state in self.MOVING_STATES

    def apply_pending_transform(self, force: bool = False) -> bool:
        """有待套用的轉換且（不在移動或 force）→ 套用，回 True"""
        if self._pending is None or (not force and self.is_moving()):
            return False
        self.set_transform(self._pending)
        return True

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

    def is_estopped(self) -> bool:
        """急停中回 True。bridge 據此丟棄遙控速度；真機韌體不一定會擋，轉接器必須自己擋。"""
        return False

    async def teleop(self, t: Teleop) -> None:
        raise CommandError("UNSUPPORTED", "teleop not supported")

    async def stop_motion(self) -> None:
        """遙控逾時（500 ms）時呼叫，必須讓機器人停下。"""

    def emit(self, ev: RobotEvent) -> None:
        self.events.put_nowait(ev)
