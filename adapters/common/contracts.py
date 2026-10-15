"""轉接器與後端之間的 MQTT 訊息格式。

必須與 packages/contracts/src/index.ts 保持一致（工程開發手冊「機器人轉接器」章節）。
座標一律是平台座標（公尺、弧度）。
"""
from __future__ import annotations

import time
from typing import Any, Literal

from pydantic import BaseModel, Field

RobotState = Literal[
    "idle", "navigating", "patrolling", "teleop", "returning",
    "charging", "paused", "estop", "fault", "offline",
]

EventType = Literal[
    "fault", "fault_cleared", "waypoint_reached", "goal_reached", "goal_failed",
    "charge_started", "charge_finished", "estop_pressed", "sos", "obstacle_blocked",
]

CommandType = Literal[
    "navigate", "patrol", "stop", "pause", "resume", "estop", "estop_release", "charge",
    "ptz", "light", "snapshot", "record_start", "record_stop", "speak", "follow",
    "follow_stop", "set_params", "lift",
]

AckStatus = Literal["accepted", "rejected", "done", "failed"]


def now_ms() -> int:
    return int(time.time() * 1000)


class Pose(BaseModel):
    x: float
    y: float
    yaw: float
    floor: str


class Battery(BaseModel):
    pct: float = Field(ge=0, le=100)
    charging: bool
    voltage: float | None = None


class Fault(BaseModel):
    code: str
    level: Literal[1, 2, 3]
    msg: str


class Net(BaseModel):
    rssi: float | None = None
    latencyMs: float | None = None


class Telemetry(BaseModel):
    ts: int = Field(default_factory=now_ms)
    pose: Pose
    battery: Battery
    state: RobotState
    speed: float | None = None
    taskRef: str | None = None
    faults: list[Fault] = []
    net: Net | None = None
    sensors: dict[str, dict[str, Any]] | None = None


class RobotEvent(BaseModel):
    ts: int = Field(default_factory=now_ms)
    type: EventType
    data: dict[str, Any] | None = None


class Command(BaseModel):
    cmdId: str
    ts: int
    type: CommandType
    args: dict[str, Any] = {}
    timeoutSec: float | None = None


class AckError(BaseModel):
    code: str
    msg: str


class Ack(BaseModel):
    cmdId: str
    ts: int = Field(default_factory=now_ms)
    status: AckStatus
    error: AckError | None = None
    result: dict[str, Any] | None = None


class Teleop(BaseModel):
    lockId: str
    vx: float
    vy: float
    wz: float
    ts: int


class AdapterStatus(BaseModel):
    ts: int = Field(default_factory=now_ms)
    name: str
    version: str
    robots: list[str]
    connected: list[str]
