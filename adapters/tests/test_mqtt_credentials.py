"""EMQX 帳號與權限（安全收尾 e）：轉接器用後端核發的 MQTT 憑證，機器人清單變了就換新憑證重連"""
import asyncio

import common.bridge as bridge_mod
from common.bridge import Bridge
from common.config_sync import apply_mqtt_credentials
from mock.driver import MockDriver


class FakeClient:
    """aiomqtt.Client 的替身：記下每次連線用的帳密與訂閱，訊息永遠等不到"""

    sessions: list["FakeClient"] = []

    def __init__(self, host, port, identifier=None, username=None, password=None, will=None):
        self.username, self.password = username, password
        self.subs: list[str] = []
        self.closed = False
        FakeClient.sessions.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.closed = True
        return False

    async def subscribe(self, topic, qos=0):
        self.subs.append(topic)

    async def unsubscribe(self, topic):
        pass

    async def publish(self, *a, **k):
        pass

    @property
    def messages(self):
        async def gen():
            await asyncio.Event().wait()
            yield None  # pragma: no cover
        return gen()


async def until(cond, timeout=3.0):
    end = asyncio.get_running_loop().time() + timeout
    while not cond():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError("等待逾時")
        await asyncio.sleep(0.01)


def test_apply_credentials_from_adapter_config():
    b = Bridge("mock", "t", [], "mqtt://localhost:1")
    apply_mqtt_credentials(b, {"robots": [{"code": "B2-001"}], "mqtt": None})
    assert b.username is None and b.password is None  # EMQX 沒開認證：不動
    apply_mqtt_credentials(b, {"robots": [{"code": "B2-001"}], "mqtt": {"username": "mock", "password": "jwt-1"}})
    assert (b.username, b.password) == ("mock", "jwt-1")


def test_reconnects_with_new_credentials_when_robot_list_changes(monkeypatch):
    FakeClient.sessions = []
    monkeypatch.setattr(bridge_mod.aiomqtt, "Client", FakeClient)

    async def go():
        b = Bridge("mock", "t", [MockDriver(code="B2-001", floor="1f")], "mqtt://localhost:1")
        b.set_credentials("mock", "jwt-1", frozenset({"B2-001"}))
        task = asyncio.create_task(b.run())
        try:
            await until(lambda: len(FakeClient.sessions) == 1 and b._client is not None)
            first = FakeClient.sessions[0]
            assert (first.username, first.password) == ("mock", "jwt-1")
            # 同樣的機器人、只換新憑證（每 10 秒同步）：不重連
            b.set_credentials("mock", "jwt-2", frozenset({"B2-001"}))
            await asyncio.sleep(0.1)
            assert len(FakeClient.sessions) == 1
            # 新增一台：舊憑證沒有它的主題 → 用新憑證重連，並訂閱新機器人
            await b.add_driver(MockDriver(code="B2-002", floor="1f"))
            b.set_credentials("mock", "jwt-3", frozenset({"B2-001", "B2-002"}))
            await until(lambda: len(FakeClient.sessions) == 2 and FakeClient.sessions[1].subs)
            second = FakeClient.sessions[1]
            assert first.closed
            assert second.password == "jwt-3"
            assert "rms/robot/B2-002/cmd" in second.subs and "rms/robot/B2-001/cmd" in second.subs
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(go())


def test_refreshes_credentials_before_reconnect_after_kick(monkeypatch):
    """被後端踢掉（機器人改派到別的轉接器）後，重連前先向後端重取憑證（PR #16 審查第 2 點）"""
    FakeClient.sessions = []
    monkeypatch.setattr(bridge_mod.aiomqtt, "Client", FakeClient)
    monkeypatch.setattr(bridge_mod, "RECONNECT_DELAY_S", 0.01)

    class Kicked(FakeClient):
        @property
        def messages(self):
            async def gen():
                raise bridge_mod.aiomqtt.MqttError("kicked")
                yield None  # pragma: no cover
            return gen()

    async def go():
        b = Bridge("mock", "t", [MockDriver(code="B2-001", floor="1f")], "mqtt://localhost:1")
        b.set_credentials("mock", "old", frozenset({"B2-001", "B2-002"}))
        fetched = []

        async def refresh():
            fetched.append(1)
            b.set_credentials("mock", f"new-{len(fetched)}", frozenset({"B2-001"}))

        b.refresh_credentials = refresh
        monkeypatch.setattr(bridge_mod.aiomqtt, "Client", Kicked)
        task = asyncio.create_task(b.run())
        try:
            await until(lambda: len(FakeClient.sessions) >= 2)
            assert FakeClient.sessions[0].password == "old"  # 第一次用手上的
            assert FakeClient.sessions[1].password == "new-1"  # 斷線後先重取
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(go())
