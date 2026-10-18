"""向後端取轉接器設定（GET /api/v1/adapter-config/{name}，機器人接入 §3）並同步座標校正。

真機轉接器與模擬器共用：啟動時取一次，之後每 10 秒同步；某台的校正（calib）變了就交給 driver，
driver 等機器人不在移動、或下一個移動指令開始時才換（PR #11 審查第 2 點）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.request
from pathlib import Path
from typing import Any

from .transform import Affine2D

log = logging.getLogger("config_sync")
SYNC_PERIOD_S = 10


def load_dotenv(path: Path) -> None:
    """讀 repo 根目錄的 .env（已存在的環境變數不覆蓋）"""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


def adapter_key(name: str) -> str:
    return os.getenv("ADAPTER_KEY_" + "".join(c if c.isalnum() else "_" for c in name.upper()), "")


def backend_url() -> str:
    return os.getenv("BACKEND_URL", "http://localhost:3000/api/v1").rstrip("/")


def fetch_adapter_config(base: str, name: str, key: str) -> dict[str, Any]:
    """整份轉接器設定：robots（機器人清單）、mqtt（後端核發的 MQTT 帳號與憑證，EMQX 有開認證時）"""
    req = urllib.request.Request(f"{base}/adapter-config/{name}", headers={"X-Adapter-Key": key})
    with urllib.request.urlopen(req, timeout=5) as r:  # noqa: S310 — 位址來自設定
        return json.loads(r.read().decode("utf-8"))


def fetch_config(base: str, name: str, key: str) -> list[dict[str, Any]]:
    return fetch_adapter_config(base, name, key)["robots"]


def apply_mqtt_credentials(bridge: Any, cfg: dict[str, Any]) -> None:
    """把後端核發的 MQTT 憑證交給 bridge（安全收尾 e）。憑證的權限只涵蓋設定裡的機器人，
    機器人清單變了 bridge 會用新憑證重連。後端沒有核發（EMQX 沒開認證的環境）就不動。"""
    m = cfg.get("mqtt")
    if not m:
        return
    bridge.set_credentials(m["username"], m["password"], frozenset(r["code"] for r in cfg["robots"]))


def transform_of(robot: dict[str, Any]) -> Affine2D:
    """後端設定裡某台的 to_robot（沒有校正 = 不轉換）"""
    return Affine2D.to_robot_from_calib(robot.get("calib"))


def request_calibrations(drivers: dict[str, Any], robots: list[dict[str, Any]]) -> list[str]:
    """把後端的校正交給各 driver（只交有變的），回傳有變的代碼"""
    changed = []
    for r in robots:
        d = drivers.get(r["code"])
        if d is None:
            continue
        tf = transform_of(r)
        if tf != d.to_robot and tf != d.pending_transform:
            d.request_transform(tf)
            changed.append(r["code"])
    return changed


def credentials_refresher(bridge: Any, base: str, name: str, key: str) -> Any:
    """給 Bridge 的 refresh_credentials：重連前向後端重取設定、套用新憑證"""

    async def refresh() -> None:
        cfg = await asyncio.to_thread(fetch_adapter_config, base, name, key)
        apply_mqtt_credentials(bridge, cfg)

    return refresh
