"""模擬機器人：沒有真機時開發後端與前端用。

會移動到目標點、耗電、充電、支援遙控；可設定 fail_rate 模擬導航失敗。
pause 讓導航停在原地（指令仍在執行），resume 從目前位置接續原本的導航——與真機（X30 等）一致。
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import shutil
import socket
import struct
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from common.contracts import Battery, Command, Pose, RobotEvent, Telemetry, Teleop, now_ms
from common.driver import CommandError, RobotDriver, split_params
from common.transform import Affine2D

TICK_S = 0.1
#: 按鍵說話音檔下載上限（後端收 5 MB；PR #15 審查第 1 點）
SPEAK_MAX_BYTES = 10 * 1024 * 1024
#: 對講音訊解碼成 16 kHz、單聲道、16-bit PCM，每 1 秒算一次音量
TALK_RATE = 16000
TALK_CHUNK = TALK_RATE * 2

log = logging.getLogger("mock")


def dbfs(pcm: bytes) -> float:
    """16-bit PCM 的音量（dBFS，0 是最大聲；靜音約 -90）"""
    n = len(pcm) // 2
    if not n:
        return -90.0
    samples = struct.unpack(f"<{n}h", pcm[: n * 2])
    rms = math.sqrt(sum(x * x for x in samples) / n)
    return max(-90.0, 20 * math.log10(rms / 32768)) if rms else -90.0


def download(url: str, limit: int = SPEAK_MAX_BYTES, timeout: float = 10.0) -> bytes:
    """下載按鍵說話的音檔（預簽名網址 5 分鐘有效）；超過上限或失敗 raise CommandError"""
    if not url.startswith(("http://", "https://")):
        raise CommandError("BAD_ARGS", "audio.url must be http(s)")
    try:
        with urlopen(url, timeout=timeout) as r:  # noqa: S310 — 只接受 http(s)，網址由後端簽發
            data = r.read(limit + 1)
    except OSError as e:
        raise CommandError("DOWNLOAD_FAILED", f"audio download failed: {e}") from e
    if len(data) > limit:
        raise CommandError("TOO_LARGE", f"audio larger than {limit} bytes")
    return data


def upload(url: str, data: bytes, content_type: str, timeout: float = 15.0) -> None:
    """把檔案 PUT 到後端給的預簽名網址（日誌上傳）"""
    if not url.startswith(("http://", "https://")):
        raise CommandError("BAD_ARGS", "url must be http(s)")
    req = Request(url, data=data, method="PUT", headers={"Content-Type": content_type})
    try:
        with urlopen(req, timeout=timeout) as r:  # noqa: S310 — 只接受 http(s)，網址由後端簽發
            r.read()
    except OSError as e:
        raise CommandError("UPLOAD_FAILED", f"log upload failed: {e}") from e


#: 日誌子系統（後端 robot_logs.subsystem）
LOG_SUBSYSTEMS = ("motion", "video", "interaction", "system")


def talk_url(url: str, user: str, token: str) -> str:
    """rtsp://主機/talk/B2-001 → rtsp://talk:<token>@<IP>/talk/B2-001。
    主機名稱先解析成 IP：靜態編譯的 ffmpeg 自己解析名稱會當掉（同後端 media/ffmpeg.ts）"""
    u = urlsplit(url)
    host = u.hostname or "localhost"
    try:
        host = socket.gethostbyname(host)
    except OSError:
        pass
    netloc = f"{quote(user, safe='')}:{quote(token, safe='')}@{host}{f':{u.port}' if u.port else ''}"
    return urlunsplit((u.scheme, netloc, u.path, u.query, ""))


class MockDriver(RobotDriver):
    capabilities = frozenset({"navigate", "patrol", "stop", "pause", "resume", "charge", "estop",
                              "estop_release", "snapshot", "ptz", "light", "follow", "follow_stop",
                              "speak", "talk_start", "talk_stop", "show_image", "upload_logs"})

    def __init__(self, code: str, floor: str, x: float = 0.0, y: float = 0.0, battery: float = 80.0,
                 speed: float = 1.0, dock: dict[str, float] | None = None, fail_rate: float = 0.0,
                 teleop: bool = True, drain_per_m: float = 0.05, charge_rate: float = 0.5,
                 to_robot: Affine2D | None = None):
        super().__init__(code, floor, to_robot)
        # 模擬器在「機器人地圖座標」裡移動，回報時換成平台座標（與真機轉接器相同）；
        # 參數給的初始位置是平台座標
        self.x, self.y = self.to_robot.apply(x, y)
        self.yaw = 0.0
        self.battery = battery
        self.max_speed = speed
        #: 設定檔的最高速度；參數「導航速度」只能往下調
        self.base_speed = speed
        self.dock = dock or {"x": x, "y": y}
        self.fail_rate = fail_rate
        self.drain_per_m = drain_per_m
        #: 充電速度（%／秒）；測試排隊情境可調快
        self.charge_rate = charge_rate
        self.state = "idle"
        self.speed = 0.0
        self._connected = False
        self._vel = (0.0, 0.0, 0.0)
        self._loop_task: asyncio.Task | None = None
        # 導航進行中時的狀態（navigating／patrolling／returning）；None 表示沒有導航
        self._goal_state: str | None = None
        # 清除＝暫停：導航迴圈停在原地等待 resume
        self._go = asyncio.Event()
        self._go.set()
        #: 雲台位置（正規化 -1..1，絕對位置）、燈光（mode → 開關）、跟隨對象；只記錄，供測試與日誌
        self.ptz = (0.0, 0.0, 0.0)
        self.lights: dict[str, bool] = {}
        self.following: str | None = None
        #: 對講（T-31）：模擬器不播放，收到音訊就記錄秒數與音量
        self.talk: dict[str, Any] | None = None
        self._talk_task: asyncio.Task | None = None
        #: 按鍵說話、文字語音：記錄收到的內容
        self.spoken: list[dict[str, Any]] = []
        #: 螢幕上顯示的警示圖（show_image；模擬器只記錄）
        self.screen: dict[str, Any] | None = None
        if teleop:
            self.capabilities = self.capabilities | {"teleop"}

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self._connected = True
        self._loop_task = asyncio.create_task(self._physics())

    async def close(self) -> None:
        self._connected = False
        if self._loop_task:
            self._loop_task.cancel()
        await self._talk_stop()

    async def _physics(self) -> None:
        while True:
            await asyncio.sleep(TICK_S)
            if self.state == "charging":
                self.battery = min(100.0, self.battery + self.charge_rate * TICK_S)
            elif self.state == "teleop":
                vx, vy, wz = self._vel
                self.yaw += wz * TICK_S
                dx = (vx * math.cos(self.yaw) - vy * math.sin(self.yaw)) * TICK_S
                dy = (vx * math.sin(self.yaw) + vy * math.cos(self.yaw)) * TICK_S
                self._advance(dx, dy)
            else:
                self.battery = max(0.0, self.battery - 0.002 * TICK_S)

    def _advance(self, dx: float, dy: float) -> None:
        self.x += dx
        self.y += dy
        dist = math.hypot(dx, dy)
        self.speed = dist / TICK_S
        self.battery = max(0.0, self.battery - dist * self.drain_per_m)

    # ---- 模擬電池（T-39 能耗管理）：48 V 鋰電池組，電壓隨電量 44～52.5 V，充電時略高 ----
    def _voltage(self) -> float:
        return round(44 + self.battery * 0.085 + (1.2 if self.state == "charging" else 0) + random.uniform(-0.15, 0.15), 2)

    def _current(self) -> float:
        """安培：充電為正，行走約 -1.5～-2.1，待命約 -0.4"""
        if self.state == "charging":
            return round(4.8 + random.uniform(0, 0.6), 2)
        if self.speed > 0.05:
            return round(-(1.5 + min(self.speed, 1.5) * 0.4 + random.uniform(0, 0.2)), 2)
        return round(-(0.35 + random.uniform(0, 0.1)), 2)

    async def read_telemetry(self) -> Telemetry:
        px, py = self.to_platform.apply(self.x, self.y)
        return Telemetry(
            ts=now_ms(),
            pose=Pose(x=round(px, 3), y=round(py, 3), yaw=round(self.to_platform.apply_yaw(self.yaw), 3), floor=self.floor),
            battery=Battery(pct=round(self.battery, 1), charging=self.state == "charging",
                            voltage=self._voltage(), current=self._current()),
            state=self.state, speed=round(self.speed, 2), taskRef=self.task_ref,
        )

    async def validate(self, cmd: Command) -> None:
        await super().validate(cmd)
        # 急停中只擋會動、會發聲的；結束對講、停止一律可以
        if self.state == "estop" and cmd.type not in {"estop_release", "stop", "talk_stop"}:
            raise CommandError("ESTOP", "robot is in emergency stop")
        if cmd.type == "talk_start" and not (cmd.args.get("url") and cmd.args.get("token")):
            raise CommandError("BAD_ARGS", "talk_start requires url and token")
        audio = cmd.args.get("audio")
        image = cmd.args.get("image")
        if cmd.type == "show_image" and not (isinstance(image, dict) and image.get("url")):
            raise CommandError("BAD_ARGS", "show_image requires image.url")
        if cmd.type == "upload_logs" and (cmd.args.get("subsystem") not in LOG_SUBSYSTEMS or not cmd.args.get("url")):
            raise CommandError("BAD_ARGS", "upload_logs requires subsystem and url")
        if cmd.type == "speak" and not (cmd.args.get("text") or (isinstance(audio, dict) and audio.get("url"))):
            raise CommandError("BAD_ARGS", "speak requires text or audio.url")

    async def _goto(self, gx: float, gy: float, state: str) -> None:
        self.state = state
        self._goal_state = state
        try:
            while True:
                if not self._go.is_set():
                    self.speed = 0.0
                    await self._go.wait()
                    self.state = state
                dx, dy = gx - self.x, gy - self.y
                dist = math.hypot(dx, dy)
                if dist < 0.05:
                    break
                step = min(dist, self.max_speed * TICK_S)
                self.yaw = math.atan2(dy, dx)
                self._advance(dx / dist * step, dy / dist * step)
                await asyncio.sleep(TICK_S)
                if self.battery <= 0:
                    raise CommandError("LOW_BATTERY", "battery depleted")
        finally:
            self.speed = 0.0
            self._goal_state = None
        if random.random() < self.fail_rate:
            raise CommandError("MOCK_NAV_FAILED", "simulated navigation failure")

    async def execute(self, cmd: Command) -> dict[str, Any] | None:
        t = cmd.type
        if t == "pause":
            # 導航停在原地，指令不結束；沒有導航時只是標成暫停
            self._go.clear()
            self.speed = 0.0
            self.state = "paused"
            return None
        if t == "resume":
            self._go.set()
            self.state = self._goal_state or "idle"
            return None
        if t == "stop":
            self._go.set()
            self.state = "idle"
            return None
        if t == "estop":
            self._go.set()
            self._vel = (0.0, 0.0, 0.0)
            self.speed = 0.0
            self.state = "estop"
            self.emit(RobotEvent(ts=now_ms(), type="estop_pressed"))
            return None
        if t == "estop_release":
            self.state = "idle"
            return None
        if t == "snapshot":
            return {"objectKey": f"mock/{self.code}/{cmd.cmdId}.jpg"}
        if t == "ptz":
            self.ptz = (float(cmd.args["pan"]), float(cmd.args["tilt"]), float(cmd.args["zoom"]))
            return None
        if t == "light":
            self.lights[str(cmd.args.get("mode") or "default")] = bool(cmd.args["on"])
            return None
        if t == "follow":
            self.following = str(cmd.args["personId"])
            return None
        if t == "follow_stop":
            self.following = None
            return None
        if t == "speak":
            return await self._speak(cmd.args)
        if t == "talk_start":
            await self._talk_stop()
            self.talk = {"seconds": 0, "bytes": 0, "peak_db": -90.0}
            url = talk_url(str(cmd.args["url"]), str(cmd.args.get("user", "talk")), str(cmd.args["token"]))
            self._talk_task = asyncio.create_task(self._talk_rx(url))
            log.info("%s 開始接收對講音訊（模擬器只記錄、不播放）", self.code)
            return {"receiving": True}
        if t == "talk_stop":
            return await self._talk_stop()
        if t == "show_image":
            img = cmd.args["image"]
            data = await asyncio.to_thread(download, str(img["url"]))
            self.screen = {"mime": img.get("mime"), "bytes": len(data), "seconds": cmd.args.get("seconds")}
            log.info("%s 螢幕顯示警示圖：%s、%d bytes（模擬器只記錄）", self.code, img.get("mime"), len(data))
            return {"shown": True}
        if t == "upload_logs":
            sub = str(cmd.args["subsystem"])
            body = self._fake_log(sub).encode("utf-8")
            await asyncio.to_thread(upload, str(cmd.args["url"]), body, "text/plain; charset=utf-8")
            log.info("%s 已上傳 %s 日誌 %d bytes", self.code, sub, len(body))
            return {"bytes": len(body)}

        self.task_ref = cmd.cmdId
        self._go.set()  # 新的移動指令取代暫停中的舊導航
        try:
            if t == "navigate":
                await self._goto(*self.to_robot.apply(float(cmd.args["x"]), float(cmd.args["y"])), "navigating")
                self.emit(RobotEvent(ts=now_ms(), type="goal_reached", data={"cmdId": cmd.cmdId}))
            elif t == "patrol":
                for i, pt in enumerate(cmd.args.get("points", [])):
                    await self._goto(*self.to_robot.apply(float(pt["x"]), float(pt["y"])), "patrolling")
                    self.emit(RobotEvent(ts=now_ms(), type="waypoint_reached", data={"cmdId": cmd.cmdId, "index": i}))
            elif t == "charge":
                # 後端排程指定充電樁時帶座標；沒帶就回自己設定的充電點
                gx = float(cmd.args.get("x", self.dock["x"]))
                gy = float(cmd.args.get("y", self.dock["y"]))
                await self._goto(*self.to_robot.apply(gx, gy), "returning")
                self.state = "charging"
                self.emit(RobotEvent(ts=now_ms(), type="charge_started"))
                return None
            self.state = "idle"
            return None
        except CommandError:
            self.state = "idle"
            self.emit(RobotEvent(ts=now_ms(), type="goal_failed", data={"cmdId": cmd.cmdId}))
            raise
        except asyncio.CancelledError:
            self.state = "idle"
            raise
        finally:
            self.task_ref = None

    async def apply_params(self, params: dict[str, Any]) -> dict[str, list[str]]:
        """模擬器：導航速度也套用到導航（真機要品牌 driver 實作才會生效），其他項目不支援"""
        limit = self.speed_limit()
        self.max_speed = min(self.base_speed, limit) if limit else self.base_speed
        return split_params(params, {"walk.speed"})

    def _fake_log(self, sub: str) -> str:
        """模擬的日誌內容：目前狀態與最近幾筆說話紀錄（真機轉接器上傳機器人的日誌檔）"""
        lines = [f"# {self.code} {sub} log (mock)", f"ts={now_ms()} state={self.state} battery={self.battery:.1f} x={self.x:.2f} y={self.y:.2f}"]
        lines += [f"spoken {i}: {item}" for i, item in enumerate(self.spoken[-5:])]
        return "\n".join(lines) + "\n"

    async def _speak(self, args: dict[str, Any]) -> dict[str, Any]:
        if isinstance(args.get("audio"), dict):
            a = args["audio"]
            # 音檔在物件儲存，指令只帶預簽名網址：下載下來（真機轉接器下載後送到喇叭）
            data = await asyncio.to_thread(download, str(a["url"]))
            item = {"kind": "audio", "mime": a.get("mime"), "bytes": len(data), "durationMs": a.get("durationMs")}
            log.info("%s 播放語音：%s、%d bytes、%.1f 秒（模擬器只記錄）", self.code, item["mime"], item["bytes"], (item["durationMs"] or 0) / 1000)
        else:
            item = {"kind": "text", "text": str(args.get("text", ""))}
            log.info("%s 播放文字語音：%s（模擬器只記錄）", self.code, item["text"])
        self.spoken.append(item)
        return {"played": item["kind"]}

    async def _talk_rx(self, url: str) -> None:
        ffmpeg = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
        if not ffmpeg:
            log.warning("%s 沒有 ffmpeg（設定 FFMPEG_PATH），只記錄對講開始與結束", self.code)
            return
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp", "-i", url,
            "-vn", "-f", "s16le", "-ac", "1", "-ar", str(TALK_RATE), "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            assert proc.stdout is not None
            await self.consume_talk(proc.stdout)
            err = (await proc.stderr.read()).decode(errors="replace").strip() if proc.stderr else ""
            reason = err.splitlines()[-1][:200] if err else "stream ended"
            log.warning("%s 對講音訊中斷：%s", self.code, reason)
            # 沒收到 talk_stop 就斷了（拉流失敗、網路中斷、憑證過期重連不上）：回報，控制室才知道機器人端已斷線
            self.emit(RobotEvent(ts=now_ms(), type="talk_failed", data={"reason": reason}))
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    async def consume_talk(self, reader: asyncio.StreamReader) -> None:
        """讀 PCM，每 1 秒記錄一次音量（真機轉接器在這裡把聲音送到喇叭）"""
        buf = b""
        while True:
            chunk = await reader.read(TALK_CHUNK)
            if not chunk:
                break
            buf += chunk
            while len(buf) >= TALK_CHUNK:
                sec, buf = buf[:TALK_CHUNK], buf[TALK_CHUNK:]
                level = dbfs(sec)
                if self.talk is not None:
                    self.talk["seconds"] += 1
                    self.talk["bytes"] += len(sec)
                    self.talk["peak_db"] = max(self.talk["peak_db"], level)
                    log.info("%s 對講音訊 第 %d 秒：音量 %.0f dBFS", self.code, self.talk["seconds"], level)

    async def _talk_stop(self) -> dict[str, Any]:
        if self._talk_task and not self._talk_task.done():
            self._talk_task.cancel()
            try:
                await self._talk_task
            except asyncio.CancelledError:
                pass
        self._talk_task = None
        stats = dict(self.talk or {})
        if self.talk is not None:
            log.info("%s 結束對講：收到 %d 秒、最大音量 %.0f dBFS", self.code, stats.get("seconds", 0), stats.get("peak_db", -90))
        self.talk = None
        return stats

    def is_estopped(self) -> bool:
        return self.state == "estop"

    async def teleop(self, t: Teleop) -> None:
        if "teleop" not in self.capabilities:
            raise CommandError("UNSUPPORTED", "teleop not supported")
        if self.is_estopped():
            raise CommandError("ESTOP", "robot is in emergency stop")
        self.state = "teleop"
        self._vel = (t.vx, t.vy, t.wz)

    async def stop_motion(self) -> None:
        self._vel = (0.0, 0.0, 0.0)
        self.speed = 0.0
        if self.state == "teleop":
            # 遙控前有暫停中的導航：回到暫停，等 resume 或新指令
            self.state = "paused" if self._goal_state and not self._go.is_set() else "idle"
