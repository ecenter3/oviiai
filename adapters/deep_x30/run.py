"""啟動 X30 轉接器：python -m deep_x30.run --config deep_x30/robots.yaml

連線資料來自 robots.yaml。有轉接器金鑰（ADAPTER_KEY_DEEP_X30）時，座標校正改用後端
「地圖管理 → 座標校正」存的結果（GET /adapter-config/deep_x30），每 10 秒同步；
機器人不在移動時才套用（PR #11 審查第 2 點）。後端沒有校正的那台沿用 robots.yaml 的 transform。
MQTT 憑證同樣由後端核發（EMQX 開認證時）：只涵蓋後端登記在 deep_x30 底下的機器人，
robots.yaml 裡沒登記的那台主題會被 EMQX 擋下。
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
from pathlib import Path

import yaml

from common.bridge import Bridge
from common.config_sync import (
    SYNC_PERIOD_S,
    adapter_key,
    apply_mqtt_credentials,
    backend_url,
    fetch_adapter_config,
    load_dotenv,
)
from common.transform import Affine2D

from .driver import X30Driver

VERSION = "0.2.0"
ADAPTER = "deep_x30"
log = logging.getLogger("deep_x30")


def load_drivers(path: str) -> list[X30Driver]:
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return [
        X30Driver(code=r["code"], floor=r["floor"], host=r["host"], port=r.get("port", 30000),
                  to_robot=Affine2D.from_dict(r.get("transform")), nav_defaults=r.get("nav_defaults"),
                  dock_point=r.get("dock_point"))
        for r in cfg["robots"]
    ]


async def calib_loop(bridge: Bridge, key: str) -> None:
    """後端有校正的機器人以後端為準；第一次立即套用，之後有變等不在移動時才換"""
    first = True
    while True:
        try:
            cfg = await asyncio.to_thread(fetch_adapter_config, backend_url(), ADAPTER, key)
            apply_mqtt_credentials(bridge, cfg)
            for r in cfg["robots"]:
                d = bridge.drivers.get(r["code"])
                if d is None or not r.get("calib"):
                    continue
                tf = Affine2D.to_robot_from_calib(r["calib"])
                if first:
                    d.set_transform(tf)
                elif tf != d.to_robot and tf != d.pending_transform:
                    d.request_transform(tf)
                    log.info("%s 座標校正有更新，機器人不在移動時套用", d.code)
            first = False
        except Exception as e:  # 後端暫時連不上：維持目前的轉換
            log.warning("取不到轉接器設定：%s", e)
        await asyncio.sleep(SYNC_PERIOD_S)


async def amain(bridge: Bridge) -> None:
    key = adapter_key(ADAPTER)
    tasks = [asyncio.create_task(bridge.run())]
    if key:
        tasks.append(asyncio.create_task(calib_loop(bridge, key)))
    await asyncio.gather(*tasks)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="deep_x30/robots.yaml")
    args = ap.parse_args()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    bridge = Bridge(ADAPTER, VERSION, load_drivers(args.config),
                    os.getenv("MQTT_URL", "mqtt://localhost:1883"),
                    os.getenv("MQTT_ADAPTER_USER"), os.getenv("MQTT_ADAPTER_PASSWORD"))
    asyncio.run(amain(bridge))


if __name__ == "__main__":
    main()
