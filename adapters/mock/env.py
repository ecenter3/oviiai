"""模擬環境感測器（第二期 T-41）：溫度、濕度、氣體等數值隨位置、時間變化，偶爾超標。

數值 = 基準（依樓層）＋ 日夜變化（溫濕度）＋ 位置變化 ＋ 雜訊 ＋ 超標事件。
超標事件平均每 `spike_every_s` 秒發生一次（每台各自獨立），挑一個項目升高（氧氣是降低）到超過後端預設閾值，
維持 30～60 秒後回落。鍵名與單位見 adapters/deep_x30/MAPPING.md「環境數值」。
"""
from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass

UNIT = {"temp": "°C", "humidity": "%", "co": "ppm", "co2": "ppm", "ch4": "%LEL", "h2s": "ppm",
        "o2": "%", "pm25": "µg/m³", "smoke": "%obs/m", "noise": "dB"}
BASE = {"temp": 24.0, "humidity": 55.0, "co": 2.0, "co2": 650.0, "ch4": 0.4, "h2s": 0.2,
        "o2": 20.9, "pm25": 18.0, "smoke": 0.1, "noise": 55.0}
#: 工廠（2F）較熱、有氣體；停車場（B1）較潮濕、有廢氣
FLOOR = {"2f": {"temp": 3.5, "humidity": 5.0, "co": 3.0, "ch4": 1.0, "noise": 12.0},
         "b1": {"temp": -1.0, "humidity": 6.0, "co": 6.0, "pm25": 15.0, "co2": 150.0}}
#: 位置變化幅度
SPATIAL = {"temp": 1.5, "humidity": 4.0, "co": 1.5, "co2": 80.0, "ch4": 0.4, "h2s": 0.15,
           "o2": 0.1, "pm25": 6.0, "smoke": 0.05, "noise": 6.0}
NOISE = {"temp": 0.15, "humidity": 0.6, "co": 0.3, "co2": 15.0, "ch4": 0.05, "h2s": 0.03,
         "o2": 0.03, "pm25": 1.5, "smoke": 0.01, "noise": 1.5}
#: 超標事件的幅度：超過後端預設閾值（溫度 35 °C、濕度 75 %、CO 35 ppm、氧氣 19.5 % 以下…）
SPIKE = {"temp": 16.0, "humidity": 28.0, "co": 50.0, "co2": 1500.0, "ch4": 16.0, "h2s": 15.0,
         "o2": -3.0, "pm25": 110.0, "smoke": 5.0, "noise": 40.0}
NONNEG = {"co", "co2", "ch4", "h2s", "pm25", "smoke"}


@dataclass
class Spike:
    kind: str
    start: float
    duration: float

    def factor(self, now: float) -> float:
        """0→1 上升 20%、維持、最後 20% 回落"""
        t = (now - self.start) / self.duration
        if t <= 0 or t >= 1:
            return 0.0
        return min(1.0, t / 0.2, (1 - t) / 0.2)


class EnvSim:
    def __init__(self, kinds: list[str], floor: str, spike_every_s: float = 3600.0,
                 rng: random.Random | None = None):
        unknown = [k for k in kinds if k not in UNIT]
        if unknown:
            raise ValueError(f"unknown sensor kinds: {unknown}")
        self.kinds = list(kinds)
        self.floor = floor
        self.spike_every_s = spike_every_s
        self.rng = rng or random.Random()
        self.spike: Spike | None = None
        self._last = time.time()

    def force_spike(self, kind: str, duration: float = 45.0, now: float | None = None) -> None:
        """立刻開始一次超標（測試、手動驗證用）"""
        self.spike = Spike(kind, now if now is not None else time.time(), duration)

    def read(self, x: float, y: float, now: float | None = None) -> dict[str, dict[str, float | str]]:
        now = now if now is not None else time.time()
        dt, self._last = max(0.0, now - self._last), now
        if self.spike and now >= self.spike.start + self.spike.duration:
            self.spike = None
        if (self.spike is None and self.kinds and self.spike_every_s > 0
                and self.rng.random() < dt / self.spike_every_s):
            self.spike = Spike(self.rng.choice(self.kinds), now, self.rng.uniform(30, 60))
        hour = (time.gmtime(now).tm_hour + 8 + time.gmtime(now).tm_min / 60) % 24  # 台北時間
        day = math.sin((hour - 9) / 24 * 2 * math.pi)
        out: dict[str, dict[str, float | str]] = {}
        for k in self.kinds:
            v = BASE[k] + FLOOR.get(self.floor, {}).get(k, 0.0)
            if k == "temp":
                v += 2.5 * day
            elif k == "humidity":
                v -= 5.0 * day
            v += SPATIAL[k] * math.sin(x / 7.0 + len(k)) * math.cos(y / 5.0)
            v += self.rng.gauss(0, NOISE[k])
            if self.spike and self.spike.kind == k:
                v += SPIKE[k] * self.spike.factor(now)
            if k in NONNEG:
                v = max(0.0, v)
            if k == "humidity":
                v = min(100.0, max(0.0, v))
            out[k] = {"value": round(v, 2), "unit": UNIT[k]}
        return out
