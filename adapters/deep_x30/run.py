"""啟動 X30 轉接器：python -m deep_x30.run --config deep_x30/robots.yaml"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os

import yaml

from common.bridge import Bridge
from common.transform import Affine2D

from .driver import X30Driver

VERSION = "0.1.0"


def load_drivers(path: str) -> list[X30Driver]:
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    return [
        X30Driver(code=r["code"], floor=r["floor"], host=r["host"], port=r.get("port", 30000),
                  to_robot=Affine2D.from_dict(r.get("transform")), nav_defaults=r.get("nav_defaults"),
                  dock_point=r.get("dock_point"))
        for r in cfg["robots"]
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="deep_x30/robots.yaml")
    args = ap.parse_args()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    bridge = Bridge("deep_x30", VERSION, load_drivers(args.config),
                    os.getenv("MQTT_URL", "mqtt://localhost:1883"),
                    os.getenv("MQTT_ADAPTER_USER"), os.getenv("MQTT_ADAPTER_PASSWORD"))
    asyncio.run(bridge.run())


if __name__ == "__main__":
    main()
