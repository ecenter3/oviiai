"""T-07 訊息格式一致性：與 packages/contracts/test/fixtures.spec.ts 讀同一份 fixtures。"""
import json
import typing
from pathlib import Path

import pytest
from pydantic import ValidationError

from common import contracts as c

FX = json.loads((Path(__file__).resolve().parents[2] / "packages/contracts/fixtures/messages.json").read_text("utf-8"))

MODELS = {
    "Telemetry": c.Telemetry,
    "RobotEvent": c.RobotEvent,
    "Command": c.Command,
    "Ack": c.Ack,
    "Teleop": c.Teleop,
    "RobotOnline": c.RobotOnline,
    "AdapterStatus": c.AdapterStatus,
}
ENUMS = {"RobotState": c.RobotState, "EventType": c.EventType, "CommandType": c.CommandType, "AckStatus": c.AckStatus}


def _cases(kind: str):
    for name, cases in FX["messages"].items():
        for i, m in enumerate(cases[kind]):
            body = {k: v for k, v in m.items() if k != "$why"}
            yield pytest.param(name, body, id=f"{name}-{m.get('$why', i)}")


def test_fixtures_cover_every_model():
    assert sorted(FX["messages"]) == sorted(MODELS)


@pytest.mark.parametrize("name", list(ENUMS))
def test_enum_matches_fixtures(name):
    assert list(typing.get_args(ENUMS[name])) == FX["enums"][name]


@pytest.mark.parametrize("name,msg", list(_cases("valid")))
def test_accepts_valid(name, msg):
    MODELS[name].model_validate_json(json.dumps(msg))


@pytest.mark.parametrize("name,msg", list(_cases("invalid")))
def test_rejects_invalid(name, msg):
    with pytest.raises(ValidationError):
        MODELS[name].model_validate_json(json.dumps(msg))
