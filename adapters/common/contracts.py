"""轉接器與後端之間的 MQTT 訊息格式。

必須與 packages/contracts/src/index.ts 保持一致（工程開發手冊「機器人接入」§2）。
兩邊都以 packages/contracts/fixtures/messages.json 測試（tests/test_contracts.py），改格式時先改 fixtures。
座標一律是平台座標（公尺、弧度）。

所有模型用 strict 模式：不把 "1" 轉成 1、"yes" 轉成 True，與 zod 的行為一致。
ts 一律必填（與 zod 相同），建構時傳 ts=now_ms()。
"""
from __future__ import annotations

import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

RobotState = Literal[
    "idle", "navigating", "patrolling", "teleop", "returning",
    "charging", "paused", "estop", "fault", "offline",
]

EventType = Literal[
    "fault", "fault_cleared", "waypoint_reached", "goal_reached", "goal_failed",
    "charge_started", "charge_finished", "estop_pressed", "sos", "obstacle_blocked",
    # 對講方案 A：拉 talk/{代碼} 失敗或中斷（T-31、PR #15 審查第 3 點）
    "talk_failed",
]

CommandType = Literal[
    "navigate", "patrol", "stop", "pause", "resume", "estop", "estop_release", "charge",
    "ptz", "light", "snapshot", "record_start", "record_stop", "speak", "follow",
    "follow_stop", "set_params", "lift",
    # 雙向對講方案 A（T-31）：從 MediaMTX 拉 talk/{robotCode} 的音訊送到機器人喇叭
    "talk_start", "talk_stop",
]

AckStatus = Literal["accepted", "rejected", "done", "failed"]


def now_ms() -> int:
    return int(time.time() * 1000)


class Msg(BaseModel):
    model_config = ConfigDict(strict=True)


class Pose(Msg):
    x: float
    y: float
    yaw: float
    floor: str


class Battery(Msg):
    pct: float = Field(ge=0, le=100)
    charging: bool
    voltage: float | None = None
    #: 安培，充電為正、放電為負（T-39 能耗管理；SDK 沒提供就不填）
    current: float | None = None


class Fault(Msg):
    code: str
    level: Literal[1, 2, 3]
    msg: str


class Sensor(Msg):
    value: float
    unit: str


class Net(Msg):
    rssi: float | None = None
    latencyMs: float | None = None


class Telemetry(Msg):
    ts: int
    pose: Pose
    battery: Battery
    state: RobotState
    speed: float | None = None
    taskRef: str | None = None
    faults: list[Fault] = []
    net: Net | None = None
    sensors: dict[str, Sensor] | None = None


class RobotEvent(Msg):
    ts: int
    type: EventType
    data: dict[str, Any] | None = None


class Command(Msg):
    cmdId: str
    ts: int
    type: CommandType
    args: dict[str, Any] = {}
    timeoutSec: float | None = None


class AckError(Msg):
    code: str
    msg: str


class Ack(Msg):
    cmdId: str
    ts: int
    status: AckStatus
    error: AckError | None = None
    result: dict[str, Any] | None = None


class Teleop(Msg):
    lockId: str
    vx: float
    vy: float
    wz: float
    ts: int


class AdapterStatus(Msg):
    """心跳每 5 秒一次。Last Will 是 {name, alive: false}，沒有 ts（遺囑在連線時就固定）。"""
    ts: int | None = None
    name: str
    alive: bool
    version: str | None = None
    robots: list[str] | None = None
    connected: list[str] | None = None


class RobotOnline(Msg):
    """rms/robot/{code}/online（retain）"""
    online: bool
    ts: int
