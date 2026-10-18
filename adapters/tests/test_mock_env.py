"""模擬環境感測器（T-41）：數值在合理範圍、隨位置變化、偶爾超標；遙測帶 sensors 並通過 contracts 驗證"""
import asyncio
import random

import pytest

from common.contracts import Telemetry
from mock.driver import MockDriver
from mock.env import UNIT, EnvSim


def test_values_in_normal_range_without_spike():
    sim = EnvSim(list(UNIT), "1f", spike_every_s=0, rng=random.Random(1))
    for i in range(50):
        v = sim.read(i * 0.7, i * 0.3, now=1_792_000_000 + i)
        assert set(v) == set(UNIT)
        assert all(x["unit"] == UNIT[k] for k, x in v.items())
        # 低於後端預設閾值
        assert v["temp"]["value"] < 35 and v["humidity"]["value"] < 75 and v["co"]["value"] < 35
        assert 19.5 < v["o2"]["value"] < 23.5 and v["ch4"]["value"] >= 0


def test_value_depends_on_position():
    sim = EnvSim(["temp"], "2f", spike_every_s=0, rng=random.Random(2))
    a = [sim.read(0, 0, now=1_792_000_000)["temp"]["value"] for _ in range(20)]
    b = [sim.read(22, 0, now=1_792_000_000)["temp"]["value"] for _ in range(20)]
    assert abs(sum(a) / 20 - sum(b) / 20) > 1


def test_spike_exceeds_threshold_then_recovers():
    sim = EnvSim(["co", "o2"], "b1", spike_every_s=0, rng=random.Random(3))
    t0 = 1_792_000_000
    sim.force_spike("co", duration=40, now=t0)
    assert sim.read(5, 5, now=t0 + 20)["co"]["value"] > 35
    assert sim.read(5, 5, now=t0 + 41)["co"]["value"] < 35
    sim.force_spike("o2", duration=40, now=t0 + 100)
    assert sim.read(5, 5, now=t0 + 120)["o2"]["value"] < 19.5


def test_random_spikes_happen_occasionally():
    sim = EnvSim(["temp"], "1f", spike_every_s=60, rng=random.Random(4))
    t0 = 1_792_000_000
    sim._last = t0
    hits = sum(1 for i in range(1, 600) if sim.read(0, 0, now=t0 + i)["temp"]["value"] > 35)
    assert 0 < hits < 600


def test_unknown_kind_rejected():
    with pytest.raises(ValueError):
        EnvSim(["radon"], "1f")


def test_telemetry_carries_sensors():
    d = MockDriver("X30-001", "2f", sensors=["temp", "co"])
    t = asyncio.run(d.read_telemetry())
    Telemetry.model_validate(t.model_dump(exclude_none=True))
    assert set(t.sensors) == {"temp", "co"} and t.sensors["co"].unit == "ppm"
    assert asyncio.run(MockDriver("B2-001", "1f").read_telemetry()).sensors is None
