"""啟動模擬機器人：python -m mock.run --config mock/robots.yaml"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os

import yaml

from common.bridge import Bridge

from .driver import MockDriver


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="mock/robots.yaml")
    args = ap.parse_args()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    with open(args.config, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    drivers = [MockDriver(**r) for r in cfg["robots"]]
    bridge = Bridge("mock", "0.1.0", drivers, os.getenv("MQTT_URL", "mqtt://localhost:1883"))
    asyncio.run(bridge.run())


if __name__ == "__main__":
    main()
