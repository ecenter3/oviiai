"""雲深處 X30 RobotServer 協定（Python 重寫）。

來源：github.com/DeepRoboticsLab/robotserver_sdk v0.1.0（MIT），src/protocol/*
- TCP，連到 106 導航主機（預設 192.168.1.106:30000）
- 每則訊息 = 16 byte 標頭 + XML 本文
  標頭：EB 90 EB 90 | length(uint16 LE) | sequence(uint16 LE) | 8 byte 0x00
- 回應以 sequence 對應請求
- 1002 即時狀態、1003 導航任務、1004 取消任務、1007 查詢任務狀態
"""
from __future__ import annotations

import struct
import xml.etree.ElementTree as ET
from dataclasses import dataclass, fields
from datetime import datetime

SYNC = b"\xeb\x90\xeb\x90"
HEADER = struct.Struct("<4sHH8s")
HEADER_SIZE = HEADER.size  # 16

TYPE_STATUS = 1002
TYPE_NAV = 1003
TYPE_CANCEL = 1004
TYPE_QUERY = 1007


class ProtocolError(Exception):
    pass


# ------------------------------------------------------------------ framing
def encode_frame(body: str, seq: int) -> bytes:
    raw = body.encode("utf-8")
    if len(raw) > 0xFFFF:
        raise ProtocolError("message body too large")
    return HEADER.pack(SYNC, len(raw), seq & 0xFFFF, b"\x00" * 8) + raw


class FrameDecoder:
    """把 TCP 位元流切成 (seq, xml) 。遇到不同步會往後找下一個 EB90EB90。"""

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> list[tuple[int, str]]:
        self._buf += data
        out: list[tuple[int, str]] = []
        while True:
            idx = self._buf.find(SYNC)
            if idx < 0:
                # 保留最後 3 byte，以免同步字被切在兩段之間
                del self._buf[: max(0, len(self._buf) - 3)]
                return out
            if idx > 0:
                del self._buf[:idx]
            if len(self._buf) < HEADER_SIZE:
                return out
            _, length, seq, _ = HEADER.unpack_from(self._buf)
            if len(self._buf) < HEADER_SIZE + length:
                return out
            body = bytes(self._buf[HEADER_SIZE: HEADER_SIZE + length])
            del self._buf[: HEADER_SIZE + length]
            out.append((seq, body.decode("utf-8", errors="replace")))


# ------------------------------------------------------------------ messages
def _timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _envelope(msg_type: int, items_xml: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<PatrolDevice>\n'
        f"<Type>{msg_type}</Type>\n<Command>1</Command>\n<Time>{_timestamp()}</Time>\n"
        f"{items_xml}</PatrolDevice>"
    )


def build_simple(msg_type: int) -> str:
    """1002 / 1004 / 1007：本文沒有參數。"""
    return _envelope(msg_type, "<Items/>\n")


@dataclass
class NavigationPoint:
    """1003 導航點。欄位意義見 X30 Pro 應用手冊；數值通常從手把建立的路線檔取得。"""

    posX: float
    posY: float
    posZ: float = 0.0
    angleYaw: float = 0.0
    value: int = 1          # 點編號，回應以此對應
    mapId: int = 0
    pointInfo: int = 0      # 0=過路點 1=任務點 3=? （待原廠確認，見 docs/x30-sdk-notes.md）
    gait: int = 0
    speed: int = 0
    manner: int = 0
    obsMode: int = 0
    navMode: int = 1
    terrain: int = 0
    posture: int = 0

    # 路線檔（default_navigation_points.json）用大寫開頭的鍵
    _JSON_KEYS = {
        "MapID": "mapId", "Value": "value", "PosX": "posX", "PosY": "posY", "PosZ": "posZ",
        "AngleYaw": "angleYaw", "PointInfo": "pointInfo", "Gait": "gait", "Speed": "speed",
        "Manner": "manner", "ObsMode": "obsMode", "NavMode": "navMode", "Terrain": "terrain",
        "Posture": "posture",
    }

    @classmethod
    def from_route_json(cls, d: dict) -> NavigationPoint:
        return cls(**{cls._JSON_KEYS[k]: v for k, v in d.items() if k in cls._JSON_KEYS})


_NAV_XML_ORDER = [
    ("MapId", "mapId"), ("Value", "value"), ("PosX", "posX"), ("PosY", "posY"), ("PosZ", "posZ"),
    ("AngleYaw", "angleYaw"), ("PointInfo", "pointInfo"), ("Gait", "gait"), ("Speed", "speed"),
    ("Manner", "manner"), ("ObsMode", "obsMode"), ("NavMode", "navMode"), ("Terrain", "terrain"),
    ("Posture", "posture"),
]


def _fmt(v: float | int) -> str:
    # 與 C++ ostream 預設一致：6 位有效數字
    return f"{v:.6g}" if isinstance(v, float) else str(v)


def build_nav(points: list[NavigationPoint]) -> str:
    items = "".join(
        "<Items>\n" + "".join(f"  <{tag}>{_fmt(getattr(p, attr))}</{tag}>\n" for tag, attr in _NAV_XML_ORDER)
        + "</Items>\n"
        for p in points
    )
    return _envelope(TYPE_NAV, items)


# ------------------------------------------------------------------ responses
@dataclass
class RealTimeStatus:
    motionState: int = 0
    posX: float = 0.0
    posY: float = 0.0
    posZ: float = 0.0
    angleYaw: float = 0.0
    roll: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0
    speed: float = 0.0
    curOdom: float = 0.0
    sumOdom: float = 0.0
    curRuntime: int = 0
    sumRuntime: int = 0
    res: float = 0.0
    x0: float = 0.0
    y0: float = 0.0
    h: int = 0
    electricity: int = 0     # 電量 %
    location: int = 0        # 0=定位正常 1=定位丟失
    RTKState: int = 0
    onDockState: int = 0
    gaitState: int = 0
    motorState: int = 0
    chargeState: int = 0
    controlMode: int = 0
    mapUpdateState: int = 0


@dataclass
class NavResult:
    value: int = 0
    errorCode: int = 0       # 0 成功 1 失敗 2 取消
    errorStatus: int = 0     # 失敗原因，見 ERROR_STATUS


@dataclass
class TaskStatus:
    value: int = 0
    status: int = 0          # 0 完成 1 執行中 -1 失敗
    errorCode: int = 0


@dataclass
class CancelResult:
    errorCode: int = 0


def parse_type(xml: str) -> int:
    root = _root(xml)
    t = root.findtext("Type")
    if t is None:
        raise ProtocolError("missing <Type>")
    return int(t)


def _root(xml: str) -> ET.Element:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        raise ProtocolError(f"bad xml: {e}") from e
    if root.tag != "PatrolDevice":
        raise ProtocolError(f"unexpected root <{root.tag}>")
    return root


def _items_to(cls, xml: str):
    items = _root(xml).find("Items")
    if items is None:
        raise ProtocolError("missing <Items>")
    obj = cls()
    for f in fields(cls):
        tag = f.name[0].upper() + f.name[1:]
        node = items.find(tag)
        if node is not None and node.text is not None:
            caster = float if f.type in ("float", float) else int
            try:
                setattr(obj, f.name, caster(float(node.text)) if caster is int else caster(node.text))
            except ValueError:
                pass
    return obj


def parse_status(xml: str) -> RealTimeStatus:
    return _items_to(RealTimeStatus, xml)


def parse_nav_result(xml: str) -> NavResult:
    return _items_to(NavResult, xml)


def parse_task_status(xml: str) -> TaskStatus:
    return _items_to(TaskStatus, xml)


def parse_cancel(xml: str) -> CancelResult:
    return _items_to(CancelResult, xml)


# 1003 失敗原因（api_reference ErrorStatus_Navigation）
ERROR_STATUS: dict[int, str] = {
    8960: "單點巡檢任務執行完成",
    8962: "單點巡檢任務被取消",
    41729: "運動狀態異常（軟急停、摔倒）",
    41730: "電量過低",
    41731: "電機過溫",
    41732: "正在使用充電器充電",
    41745: "導航進程未啟動",
    41746: "導航模塊通訊異常",
    41747: "定位狀態持續異常（超過 30 秒）",
    41748: "地形模塊狀態異常",
    41761: "發送起立失敗",
    41762: "執行起立失敗",
    41763: "切換力控失敗",
    41764: "切換行走模式失敗",
    41765: "趴下失敗",
    41766: "被軟急停",
    41767: "切換步態失敗",
    41768: "切換導航模式失敗",
    41769: "切換手動模式失敗",
    41770: "切換正常/匍匐身高失敗",
    41777: "切換停避障速度輸入源失敗",
    41778: "設置地形圖參數失敗",
    41793: "正在執行任務，新任務被拒",
    41794: "調度退出自主充電失敗",
    41795: "退出自主充電執行失敗",
    41796: "調度進入自主充電失敗",
    41797: "進入自主充電執行失敗",
    41798: "退樁後重定位失敗",
    41799: "開啟累積幀失敗",
    41800: "關閉累積幀失敗",
    41801: "切換地圖失敗",
    41802: "上位機連線中斷，任務自動停止",
    41803: "持續停障異常",
    41804: "導航全局規劃失敗",
    41805: "持續導航速度未刷新",
    41806: "自主充電流程中，無法下發任務",
    41881: "重定位失敗",
    41983: "進程手動重啟中，任務停止",
}

# 這些失敗屬於機器人本身異常，應同時發 fault 事件（告警）
FAULT_STATUSES = {41729, 41731, 41745, 41746, 41747, 41748, 41766, 41803, 41881}
