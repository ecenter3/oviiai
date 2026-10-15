"""X30 RobotServer 非同步 TCP 用戶端。

行為與原廠 C++ SDK 一致：
- 1002 / 1004 / 1007 為一問一答，3 秒逾時
- 1003 送出後，整條路線跑完（成功、失敗或取消）才會收到一次回應
注意：原廠載明「上位機連線中斷會自動停止任務」(41802)，所以這條連線要保持穩定。
"""
from __future__ import annotations

import asyncio
import logging
from itertools import count

from . import protocol as p

log = logging.getLogger("x30.client")

REQUEST_TIMEOUT_S = 3.0
CONNECT_TIMEOUT_S = 5.0


class X30Client:
    def __init__(self, host: str, port: int = 30000):
        self.host, self.port = host, port
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._recv_task: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future[str]] = {}
        self._seq = count(1)
        self._send_lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._writer.is_closing()

    async def connect(self) -> None:
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(self.host, self.port), CONNECT_TIMEOUT_S)
        self._recv_task = asyncio.create_task(self._recv_loop())
        log.info("connected to X30 %s:%s", self.host, self.port)

    async def close(self) -> None:
        if self._recv_task:
            self._recv_task.cancel()
        if self._writer:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except OSError:
                pass
        self._writer = None
        self._fail_all(ConnectionError("closed"))

    def _fail_all(self, exc: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    async def _recv_loop(self) -> None:
        dec = p.FrameDecoder()
        assert self._reader is not None
        try:
            while True:
                data = await self._reader.read(4096)
                if not data:
                    raise ConnectionError("connection closed by robot")
                for seq, body in dec.feed(data):
                    fut = self._pending.pop(seq, None)
                    if fut and not fut.done():
                        fut.set_result(body)
                    else:
                        log.debug("unsolicited message seq=%s", seq)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("X30 %s link lost: %s", self.host, e)
            if self._writer:
                self._writer.close()
            self._writer = None
            self._fail_all(ConnectionError(str(e)))

    async def _send(self, body: str) -> asyncio.Future[str]:
        if not self.connected:
            raise ConnectionError("not connected")
        seq = next(self._seq) & 0xFFFF
        fut: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._pending[seq] = fut
        async with self._send_lock:
            assert self._writer is not None
            self._writer.write(p.encode_frame(body, seq))
            await self._writer.drain()
        return fut

    async def _request(self, body: str, timeout: float | None = REQUEST_TIMEOUT_S) -> str:
        fut = await self._send(body)
        return await (asyncio.wait_for(fut, timeout) if timeout else fut)

    # ---------------------------------------------------------------- API
    async def get_status(self) -> p.RealTimeStatus:
        return p.parse_status(await self._request(p.build_simple(p.TYPE_STATUS)))

    async def query_task(self) -> p.TaskStatus:
        return p.parse_task_status(await self._request(p.build_simple(p.TYPE_QUERY)))

    async def cancel_task(self) -> bool:
        return p.parse_cancel(await self._request(p.build_simple(p.TYPE_CANCEL))).errorCode == 0

    async def navigate(self, points: list[p.NavigationPoint]) -> p.NavResult:
        """送出路線並等到整條路線結束。被取消（asyncio）時不會自動送 1004，呼叫端自行決定。"""
        if not points:
            raise ValueError("points must not be empty")
        return p.parse_nav_result(await self._request(p.build_nav(points), timeout=None))
