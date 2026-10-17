"""MQTT <-> RobotDriver 橋接。所有品牌共用。

- 每台機器人 1 Hz 發 telemetry；指令先回 accepted，完成後回 done / failed。
- 遙控 500 ms 沒收到新的一筆就呼叫 stop_motion()。
- 一個轉接器程序可帶多台機器人；程序的 LWT 掛在 rms/adapter/{name}/status，
  後端看到 alive=false 會把該轉接器的機器人全部視為離線。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiomqtt
from pydantic import ValidationError

from . import topics
from .contracts import Ack, AckError, AdapterStatus, Command, RobotOnline, Teleop, now_ms
from .driver import CommandError, RobotDriver

log = logging.getLogger("bridge")

TELEMETRY_PERIOD_S = 1.0
TELEOP_TIMEOUT_S = 0.5
HEARTBEAT_PERIOD_S = 5.0
#: 會取代機器人目前動作的指令
MOVE_COMMANDS = frozenset({"navigate", "patrol", "charge", "stop", "estop"})
RECONNECT_DELAY_S = 3.0


def _json(model: Any) -> str:
    return model.model_dump_json(exclude_none=True)


class Bridge:
    def __init__(self, name: str, version: str, drivers: list[RobotDriver], mqtt_url: str,
                 username: str | None = None, password: str | None = None):
        self.name = name
        self.version = version
        self.drivers = {d.code: d for d in drivers}
        host, _, port = mqtt_url.removeprefix("mqtt://").partition(":")
        self.host, self.port = host, int(port or 1883)
        self.username, self.password = username, password
        self._client: aiomqtt.Client | None = None
        self._teleop_deadline: dict[str, float] = {}
        self._running: dict[str, asyncio.Task] = {}
        # 非移動指令（pause、ptz、snapshot…）的 task：asyncio 對 task 只保留弱參考，
        # 這裡保留強參考直到完成，避免執行途中被回收（PR #7 審查第 1 點）
        self._side: set[asyncio.Task] = set()
        # 每台機器人的遙測、事件迴圈；可在執行中新增、移除機器人（模擬器依後端設定增減）
        self._loops: dict[str, list[asyncio.Task]] = {}

    # ---------------------------------------------------------------- run
    async def run(self) -> None:
        while True:
            try:
                await self._session()
            except aiomqtt.MqttError as e:
                log.warning("mqtt disconnected: %s; retry in %ss", e, RECONNECT_DELAY_S)
                await asyncio.sleep(RECONNECT_DELAY_S)

    async def _session(self) -> None:
        will = aiomqtt.Will(topics.adapter_status(self.name),
                            _json(AdapterStatus(name=self.name, alive=False)), qos=1, retain=True)
        async with aiomqtt.Client(self.host, self.port, identifier=f"adapter-{self.name}",
                                  username=self.username, password=self.password, will=will) as client:
            self._client = client
            for code in self.drivers:
                await client.subscribe(topics.cmd(code), qos=1)
                await client.subscribe(topics.teleop(code), qos=0)
            log.info("connected to mqtt %s:%s with %d robots", self.host, self.port, len(self.drivers))
            try:
                for d in self.drivers.values():
                    self._start_loops(d)
                async with asyncio.TaskGroup() as tg:
                    tg.create_task(self._heartbeat_loop())
                    tg.create_task(self._teleop_watchdog())
                    async for msg in client.messages:
                        await self.on_message(str(msg.topic), msg.payload)
            finally:
                for code in list(self._loops):
                    self._stop_loops(code)
                self._client = None

    # ---------------------------------------------------------------- robots
    async def add_driver(self, d: RobotDriver) -> None:
        """執行中新增一台（已連上 MQTT 就立即訂閱並開始送遙測）"""
        if d.code in self.drivers:
            return
        self.drivers[d.code] = d
        if self._client is not None:
            await self._client.subscribe(topics.cmd(d.code), qos=1)
            await self._client.subscribe(topics.teleop(d.code), qos=0)
            self._start_loops(d)
        log.info("robot %s added", d.code)

    async def remove_driver(self, code: str) -> None:
        """執行中移除一台：停止迴圈、回報離線、斷開機器人"""
        d = self.drivers.pop(code, None)
        if d is None:
            return
        self._stop_loops(code)
        self._teleop_deadline.pop(code, None)
        if self._client is not None:
            await self._client.unsubscribe(topics.cmd(code))
            await self._client.unsubscribe(topics.teleop(code))
            await self.publish(topics.online(code), _json(RobotOnline(online=False, ts=now_ms())), qos=1, retain=True)
        await d.close()
        log.info("robot %s removed", code)

    def _start_loops(self, d: RobotDriver) -> None:
        self._loops[d.code] = [asyncio.create_task(self._robot_loop(d)), asyncio.create_task(self._event_loop(d))]

    def _stop_loops(self, code: str) -> None:
        for t in self._loops.pop(code, []):
            t.cancel()

    async def publish(self, topic: str, payload: str, qos: int = 0, retain: bool = False) -> None:
        if self._client is not None:
            await self._client.publish(topic, payload, qos=qos, retain=retain)

    # ---------------------------------------------------------------- loops
    async def _heartbeat_loop(self) -> None:
        while True:
            st = AdapterStatus(ts=now_ms(), name=self.name, alive=True, version=self.version,
                               robots=list(self.drivers),
                               connected=[c for c, d in self.drivers.items() if d.connected])
            await self.publish(topics.adapter_status(self.name), _json(st), qos=1, retain=True)
            await asyncio.sleep(HEARTBEAT_PERIOD_S)

    async def _robot_loop(self, d: RobotDriver) -> None:
        was_online: bool | None = None
        while True:
            if not d.connected:
                try:
                    await d.connect()
                except Exception as e:  # 連線失敗只記錄，下一輪重試
                    log.warning("%s connect failed: %s", d.code, e)
            if d.connected != was_online:
                was_online = d.connected
                await self.publish(topics.online(d.code), _json(RobotOnline(online=was_online, ts=now_ms())),
                                   qos=1, retain=True)
            if d.connected:
                try:
                    t = await d.read_telemetry()
                    await self.publish(topics.telemetry(d.code), _json(t))
                    d.last_state = t.state
                    # 新的座標校正：等機器人不在移動時才套用（下一筆遙測就用新轉換）
                    if d.apply_pending_transform():
                        log.info("%s 套用新的座標校正", d.code)
                except Exception as e:
                    log.warning("%s telemetry failed: %s", d.code, e)
            await asyncio.sleep(TELEMETRY_PERIOD_S)

    async def _event_loop(self, d: RobotDriver) -> None:
        while True:
            ev = await d.events.get()
            await self.publish(topics.event(d.code), _json(ev), qos=1)

    async def _teleop_watchdog(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            now = loop.time()
            for code, deadline in list(self._teleop_deadline.items()):
                if now > deadline:
                    del self._teleop_deadline[code]
                    log.info("%s teleop timeout -> stop", code)
                    await self.drivers[code].stop_motion()
            await asyncio.sleep(0.1)

    # ---------------------------------------------------------------- messages
    async def on_message(self, topic: str, payload: bytes | bytearray | str | Any) -> None:
        try:
            code = topics.code_from_topic(topic)
        except ValueError:
            return
        d = self.drivers.get(code)
        if d is None:
            return
        kind = topic.rsplit("/", 1)[-1]
        if kind == "cmd":
            await self._on_cmd(d, payload)
        elif kind == "teleop":
            await self._on_teleop(d, payload)

    async def _on_teleop(self, d: RobotDriver, payload: Any) -> None:
        if d.is_estopped():
            # 急停中丟棄遙控速度（後端也會擋，這裡是第二道）；不續期 watchdog
            self._teleop_deadline.pop(d.code, None)
            log.warning("%s teleop ignored: robot is in emergency stop", d.code)
            return
        try:
            t = Teleop.model_validate_json(payload)
            await d.teleop(t)
            self._teleop_deadline[d.code] = asyncio.get_running_loop().time() + TELEOP_TIMEOUT_S
        except (ValidationError, CommandError) as e:
            log.warning("%s teleop ignored: %s", d.code, e)

    async def _ack(self, code: str, ack: Ack) -> None:
        await self.publish(topics.ack(code), _json(ack), qos=1)

    async def _on_cmd(self, d: RobotDriver, payload: Any) -> None:
        try:
            cmd = Command.model_validate_json(payload)
        except ValidationError as e:
            log.warning("%s bad cmd: %s", d.code, e)
            return
        try:
            if not d.connected:
                raise CommandError("OFFLINE", f"{d.code} is not connected")
            await d.validate(cmd)
        except CommandError as e:
            await self._ack(d.code, Ack(ts=now_ms(), cmdId=cmd.cmdId, status="rejected", error=AckError(code=e.code, msg=e.msg)))
            return
        await self._ack(d.code, Ack(ts=now_ms(), cmdId=cmd.cmdId, status="accepted"))
        task = asyncio.create_task(self._run_cmd(d, cmd))
        # 新的移動指令會取代舊的：舊的那筆回報 CANCELLED。
        # 只有移動指令記為「目前執行中」；pause、resume、ptz 等不取代它，
        # 否則之後的 navigate 找不到舊導航、兩個導航同時跑。
        if cmd.type in MOVE_COMMANDS:
            prev = self._running.pop(d.code, None)
            if prev and not prev.done():
                prev.cancel()
            self._running[d.code] = task
        else:
            self._side.add(task)
            task.add_done_callback(self._side.discard)

    async def _run_cmd(self, d: RobotDriver, cmd: Command) -> None:
        try:
            # 移動指令開始前一定換成最新的校正：目標座標用新的轉換換算
            if cmd.type in MOVE_COMMANDS and d.apply_pending_transform(force=True):
                log.info("%s 送 %s 前套用新的座標校正", d.code, cmd.type)
            coro = d.execute(cmd)
            result = await (asyncio.wait_for(coro, cmd.timeoutSec) if cmd.timeoutSec else coro)
            await self._ack(d.code, Ack(ts=now_ms(), cmdId=cmd.cmdId, status="done", result=result))
        except CommandError as e:
            await self._ack(d.code, Ack(ts=now_ms(), cmdId=cmd.cmdId, status="failed", error=AckError(code=e.code, msg=e.msg)))
        except TimeoutError:
            await self._ack(d.code, Ack(ts=now_ms(), cmdId=cmd.cmdId, status="failed",
                                        error=AckError(code="TIMEOUT", msg=f"exceeded {cmd.timeoutSec}s")))
        except asyncio.CancelledError:
            await self._ack(d.code, Ack(ts=now_ms(), cmdId=cmd.cmdId, status="failed",
                                        error=AckError(code="CANCELLED", msg="superseded by a newer command")))
        except Exception as e:
            log.exception("%s cmd %s crashed", d.code, cmd.cmdId)
            await self._ack(d.code, Ack(ts=now_ms(), cmdId=cmd.cmdId, status="failed", error=AckError(code="INTERNAL", msg=str(e))))
