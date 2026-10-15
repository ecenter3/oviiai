"""MQTT 主題名稱。不可自行更名（見 CLAUDE.md）。"""


def telemetry(code: str) -> str:
    return f"rms/robot/{code}/telemetry"


def event(code: str) -> str:
    return f"rms/robot/{code}/event"


def cmd(code: str) -> str:
    return f"rms/robot/{code}/cmd"


def ack(code: str) -> str:
    return f"rms/robot/{code}/ack"


def teleop(code: str) -> str:
    return f"rms/robot/{code}/teleop"


def online(code: str) -> str:
    return f"rms/robot/{code}/online"


def adapter_status(name: str) -> str:
    return f"rms/adapter/{name}/status"


def code_from_topic(topic: str) -> str:
    """rms/robot/X30-001/cmd -> X30-001"""
    parts = topic.split("/")
    if len(parts) != 4 or parts[0] != "rms" or parts[1] != "robot":
        raise ValueError(f"not a robot topic: {topic}")
    return parts[2]
