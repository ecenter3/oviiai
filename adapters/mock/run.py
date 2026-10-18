"""啟動模擬機器人：python -m mock.run --config mock/robots.yaml

有轉接器金鑰（環境變數或 repo 根目錄 .env 的 ADAPTER_KEY_MOCK）時，機器人清單改從後端
GET /api/v1/adapter-config/mock 取得（機器人接入 §3），每 10 秒同步一次：在「機器人管理」新增
adapter=mock 的機器人，模擬器就會跟著出現；停用則移除；座標校正有變就套用（機器人不在移動時）。
robots.yaml 只提供已知機器人的初始位置與參數。
後端連不上時沿用 robots.yaml。
MQTT 帳號與憑證也由後端核發（EMQX 開認證時，安全收尾 e）：只能發布、訂閱自己機器人的主題，
機器人清單變了就用新憑證重連。沒有轉接器金鑰時用 MQTT_ADAPTER_USER／MQTT_ADAPTER_PASSWORD（EMQX 沒開認證才連得上）。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
from pathlib import Path
from typing import Any

import yaml

from common.bridge import Bridge
from common.config_sync import (
    adapter_key,
    apply_mqtt_credentials,
    backend_url,
    credentials_refresher,
    fetch_adapter_config,
    load_dotenv,
    request_calibrations,
    transform_of,
)

from .driver import MockDriver

log = logging.getLogger("mock")
SYNC_PERIOD_S = 10
ADAPTER = "mock"


def driver_spec(robot: dict[str, Any], defaults: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """後端設定的一台 → MockDriver 參數。yaml 有這台就用 yaml 的位置與參數；
    新的機器人放在同樓層第一座同品牌充電樁旁 2 公尺，電量 80%，充電樁座標當回充點。"""
    code = robot["code"]
    if code in defaults:
        spec = dict(defaults[code])
        spec["floor"] = robot["floor"]
        spec["to_robot"] = transform_of(robot)
        return spec
    chargers = robot.get("chargers") or []
    dock = {"x": float(chargers[0]["x"]), "y": float(chargers[0]["y"])} if chargers else {"x": 5.0, "y": 5.0}
    return {"code": code, "floor": robot["floor"], "x": dock["x"] + 2, "y": dock["y"], "battery": 80,
            "speed": 1.0, "dock": dock, "to_robot": transform_of(robot)}


def plan_sync(current: set[str], robots: list[dict[str, Any]],
              defaults: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """比對目前在跑的機器人與後端設定：回傳（要新增的 MockDriver 參數、要移除的代碼）"""
    wanted = {r["code"]: r for r in robots}
    add = [driver_spec(r, defaults) for c, r in wanted.items() if c not in current]
    remove = sorted(current - set(wanted))
    return add, remove


async def sync_loop(bridge: Bridge, base: str, key: str, defaults: dict[str, dict[str, Any]]) -> None:
    warned = False
    while True:
        try:
            cfg = await asyncio.to_thread(fetch_adapter_config, base, ADAPTER, key)
            robots = cfg["robots"]
            add, remove = plan_sync(set(bridge.drivers), robots, defaults)
            # 先移除（還在舊憑證的權限內，送得出離線），再新增；憑證範圍變了 bridge 會重連
            for code in remove:
                await bridge.remove_driver(code)
            for spec in add:
                await bridge.add_driver(MockDriver(**spec))
            apply_mqtt_credentials(bridge, cfg)
            for code in request_calibrations(bridge.drivers, robots):
                log.info("%s 座標校正有更新，機器人不在移動時套用", code)
            warned = False
        except Exception as e:  # 後端暫時連不上：維持目前的清單
            if not warned:
                log.warning("取不到轉接器設定（%s），維持目前 %d 台", e, len(bridge.drivers))
                warned = True
        await asyncio.sleep(SYNC_PERIOD_S)


async def amain(cfg: dict[str, Any]) -> None:
    defaults = {r["code"]: r for r in cfg["robots"]}
    key = adapter_key(ADAPTER)
    base = backend_url()
    drivers: list[MockDriver]
    cfg: dict[str, Any] | None = None
    if key:
        try:
            cfg = await asyncio.to_thread(fetch_adapter_config, base, ADAPTER, key)
            drivers = [MockDriver(**driver_spec(r, defaults)) for r in cfg["robots"]]
            log.info("從後端取得 %d 台機器人設定", len(drivers))
        except Exception as e:
            log.warning("取不到轉接器設定（%s），改用 robots.yaml", e)
            drivers = [MockDriver(**r) for r in cfg["robots"]]
    else:
        drivers = [MockDriver(**r) for r in cfg["robots"]]
    bridge = Bridge(ADAPTER, "0.2.0", drivers, os.getenv("MQTT_URL", "mqtt://localhost:1883"),
                    os.getenv("MQTT_ADAPTER_USER"), os.getenv("MQTT_ADAPTER_PASSWORD"))
    if cfg:
        apply_mqtt_credentials(bridge, cfg)
    if key:
        bridge.refresh_credentials = credentials_refresher(bridge, base, ADAPTER, key)
    tasks = [asyncio.create_task(bridge.run())]
    if key:
        tasks.append(asyncio.create_task(sync_loop(bridge, base, key, defaults)))
    await asyncio.gather(*tasks)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="mock/robots.yaml")
    args = ap.parse_args()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    with open(args.config, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    asyncio.run(amain(cfg))


if __name__ == "__main__":
    main()
