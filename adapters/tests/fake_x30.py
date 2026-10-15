"""測試用的假 X30 導航主機：照原廠協定回應。"""
from __future__ import annotations

import asyncio
import xml.etree.ElementTree as ET

from deep_x30 import protocol as p


def _resp(msg_type: int, items: dict) -> str:
    inner = "".join(f"<{k}>{v}</{k}>" for k, v in items.items())
    return (f'<?xml version="1.0" encoding="UTF-8"?><PatrolDevice><Type>{msg_type}</Type>'
            f"<Command>1</Command><Time>2026-10-15 10:00:00</Time><Items>{inner}</Items></PatrolDevice>")


class FakeX30:
    def __init__(self, nav_seconds: float = 0.2, nav_error_status: int = 0):
        self.nav_seconds = nav_seconds
        self.nav_error_status = nav_error_status
        self.status = {"PosX": 1.5, "PosY": -2.0, "AngleYaw": 0.5, "Electricity": 76, "Location": 0,
                       "MotorState": 0, "ChargeState": 0, "Speed": 0.3, "SumOdom": 1234.5}
        self.received: list[tuple[int, str]] = []
        self.cancelled = asyncio.Event()
        self._server: asyncio.base_events.Server | None = None
        self.port = 0

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        dec = p.FrameDecoder()
        try:
            while data := await reader.read(4096):
                for seq, body in dec.feed(data):
                    self.received.append((seq, body))
                    t = p.parse_type(body)
                    if t == p.TYPE_STATUS:
                        writer.write(p.encode_frame(_resp(1002, self.status), seq))
                    elif t == p.TYPE_QUERY:
                        writer.write(p.encode_frame(_resp(1007, {"Value": 1, "Status": 1, "ErrorCode": 1}), seq))
                    elif t == p.TYPE_CANCEL:
                        self.cancelled.set()
                        writer.write(p.encode_frame(_resp(1004, {"ErrorCode": 0}), seq))
                    elif t == p.TYPE_NAV:
                        last = ET.fromstring(body).findall("Items")[-1].findtext("Value")
                        asyncio.create_task(self._finish_nav(writer, seq, int(last)))
                    await writer.drain()
        finally:
            writer.close()

    async def _finish_nav(self, writer: asyncio.StreamWriter, seq: int, value: int) -> None:
        done = asyncio.create_task(asyncio.sleep(self.nav_seconds))
        cancel = asyncio.create_task(self.cancelled.wait())
        finished, pending = await asyncio.wait({done, cancel}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        if cancel in finished:
            items = {"Value": value, "ErrorCode": 2, "ErrorStatus": 8962}
        elif self.nav_error_status:
            items = {"Value": value, "ErrorCode": 1, "ErrorStatus": self.nav_error_status}
        else:
            items = {"Value": value, "ErrorCode": 0, "ErrorStatus": 8960}
        writer.write(p.encode_frame(_resp(1003, items), seq))
        await writer.drain()
