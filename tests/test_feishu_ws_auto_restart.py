from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import gateway.app as app_mod
from gateway.app import GatewayApp
from gateway.models import InboundEvent
from platforms.feishu import config as feishu_config
from platforms.feishu import gateway as feishu_gateway
from platforms.feishu.gateway import FeishuStreamAdapter


class _FakeRouter:
    def bind_scheduler(self, _scheduler) -> None:
        return None

    async def route_message(self, _event) -> None:
        return None


class _FakeRegistry:
    def __init__(self, adapter: Any | None = None) -> None:
        self.adapter = adapter

    def list(self) -> list:
        return [self.adapter] if self.adapter is not None else []

    def get(self, platform: str):
        if platform == "feishu" and self.adapter is not None:
            return self.adapter
        raise RuntimeError(f"unknown channel adapter: {platform}")

    def adapter_keys(self) -> list[str]:
        return ["feishu"] if self.adapter is not None else []

    async def start_all(self) -> None:
        return None

    async def stop_all(self, timeout_s: float | None = None) -> None:
        if self.adapter is not None:
            await self.adapter.stop()

    async def health_snapshot(self) -> dict:
        return {"feishu": self.adapter.health()} if self.adapter is not None else {}


class _FakeFeishuAdapter:
    platform = "feishu"

    def __init__(
        self,
        *,
        stop_error: BaseException | None = None,
        start_error: BaseException | None = None,
    ) -> None:
        self.events: list[str] = []
        self.running = True
        self.stop_error = stop_error
        self.start_error = start_error

    def set_inbound_sink(self, _sink) -> None:
        return None

    async def start(self) -> None:
        self.events.append("start")
        if self.start_error is not None:
            raise self.start_error
        self.running = True

    async def stop(self) -> None:
        self.events.append("stop")
        self.running = False
        if self.stop_error is not None:
            raise self.stop_error

    def health(self) -> dict:
        return {
            "running": self.running,
            "connection_state": "connected" if self.running else "stopped",
            "events": list(self.events),
        }


class _SlowFeishuAdapter(_FakeFeishuAdapter):
    def __init__(self) -> None:
        super().__init__()
        self.stop_started = asyncio.Event()
        self.release_stop = asyncio.Event()

    async def stop(self) -> None:
        self.events.append("stop")
        self.running = False
        self.stop_started.set()
        await self.release_stop.wait()


class _FakeThread:
    name = "adapter:feishu"

    def __init__(self, alive: bool) -> None:
        self._alive = alive

    def is_alive(self) -> bool:
        return self._alive


def _app(adapter: Any | None = None) -> GatewayApp:
    app = GatewayApp(registry=_FakeRegistry(adapter), session_router=_FakeRouter())
    app._dashboard_server = None
    return app


def _inbound_event() -> InboundEvent:
    return InboundEvent(
        platform="feishu",
        event_type="message",
        user_input="hello",
        user_id="user",
        conversation_id="chat",
        is_group=False,
        message_id="msg",
    )


def test_feishu_ws_auto_restart_defaults() -> None:
    assert feishu_config.FEISHU_WS_AUTO_RESTART_ENABLED is True
    assert feishu_config.FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS == 5400
    assert feishu_config.FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS == 30
    assert feishu_config.FEISHU_WS_AUTO_RESTART_RETRY_SECONDS == 60


def test_feishu_adapter_health_connection_states(monkeypatch) -> None:
    monkeypatch.setattr(feishu_gateway, "validate_feishu_runtime_config", lambda: None)
    adapter = FeishuStreamAdapter()

    assert adapter.health()["connection_state"] == "stopped"

    adapter._thread = _FakeThread(True)
    adapter._client = SimpleNamespace(_conn=SimpleNamespace(closed=False))
    connected = adapter.health()
    assert connected["connection_state"] == "connected"
    assert connected["connection_alive"] is True
    assert connected["last_connected_at"]

    adapter._client = SimpleNamespace(_conn=SimpleNamespace(closed=True))
    disconnected = adapter.health()
    assert disconnected["connection_state"] == "disconnected"
    assert disconnected["connection_alive"] is False
    assert disconnected["last_disconnected_at"]

    adapter._thread = None
    adapter._start_error = RuntimeError("start exploded")
    failed = adapter.health()
    assert failed["connection_state"] == "failed"
    assert failed["thread_alive"] is False


def test_feishu_restart_monitor_skips_disabled_and_missing_adapter(monkeypatch) -> None:
    async def _run() -> None:
        monkeypatch.setattr(app_mod, "FEISHU_GATEWAY_ENABLED", False)
        monkeypatch.setattr(app_mod, "FEISHU_WS_AUTO_RESTART_ENABLED", True)
        app = _app(_FakeFeishuAdapter())
        app._start_feishu_restart_monitor()
        assert app._feishu_restart_task is None

        monkeypatch.setattr(app_mod, "FEISHU_GATEWAY_ENABLED", True)
        monkeypatch.setattr(app_mod, "FEISHU_WS_AUTO_RESTART_ENABLED", False)
        app = _app(_FakeFeishuAdapter())
        app._start_feishu_restart_monitor()
        assert app._feishu_restart_task is None

        monkeypatch.setattr(app_mod, "FEISHU_WS_AUTO_RESTART_ENABLED", True)
        app = _app()
        app._start_feishu_restart_monitor()
        assert app._feishu_restart_task is None

    asyncio.run(_run())


def test_feishu_restart_idle_gateway_restarts_adapter() -> None:
    async def _run() -> None:
        adapter = _FakeFeishuAdapter()
        app = _app(adapter)

        assert await app._restart_feishu_when_idle_once() is True

        assert adapter.events == ["stop", "start"]
        assert adapter.running is True

    asyncio.run(_run())


def test_feishu_restart_continues_start_after_sdk_stop_cancelled() -> None:
    async def _run() -> None:
        adapter = _FakeFeishuAdapter(stop_error=asyncio.CancelledError())
        app = _app(adapter)

        assert await app._restart_feishu_when_idle_once() is True

        assert adapter.events == ["stop", "start"]
        assert adapter.running is True
        assert app._feishu_last_restart_error == ""
        assert app._feishu_restart_in_progress is False

    asyncio.run(_run())


def test_feishu_restart_start_failure_returns_retryable_failure() -> None:
    async def _run() -> None:
        adapter = _FakeFeishuAdapter(start_error=RuntimeError("start exploded"))
        app = _app(adapter)

        assert await app._restart_feishu_when_idle_once() is False

        assert adapter.events == ["stop", "start"]
        assert "phase=start" in app._feishu_last_restart_error
        assert "start exploded" in app._feishu_last_restart_error
        assert app._feishu_restart_in_progress is False

    asyncio.run(_run())


def test_feishu_restart_monitor_retries_after_start_failure(monkeypatch) -> None:
    async def _run() -> None:
        adapter = _FakeFeishuAdapter(start_error=RuntimeError("start exploded"))
        app = _app(adapter)
        sleeps: list[float] = []

        async def fake_sleep(delay_s: float) -> bool:
            sleeps.append(delay_s)
            if len(sleeps) == 1:
                return True
            app._stop_event.set()
            return False

        monkeypatch.setattr(app_mod, "FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS", 5400)
        monkeypatch.setattr(app_mod, "FEISHU_WS_AUTO_RESTART_RETRY_SECONDS", 60)
        app._sleep_or_stop = fake_sleep

        await app._feishu_restart_loop()

        assert adapter.events == ["stop", "start"]
        assert sleeps == [5400, 60]
        assert "phase=start" in app._feishu_last_restart_error

    asyncio.run(_run())


def test_feishu_restart_single_flight_blocks_concurrent_restart() -> None:
    async def _run() -> None:
        adapter = _SlowFeishuAdapter()
        app = _app(adapter)

        first = asyncio.create_task(app._restart_feishu_when_idle_once())
        await adapter.stop_started.wait()

        assert await app._restart_feishu_when_idle_once() is False

        adapter.release_stop.set()
        assert await first is True
        assert adapter.events == ["stop", "start"]

    asyncio.run(_run())


def test_feishu_channel_health_snapshot_overlays_restart_state() -> None:
    async def _run() -> None:
        adapter = _FakeFeishuAdapter()
        app = _app(adapter)
        app._feishu_restart_in_progress = True
        app._feishu_next_restart_at = "2026-07-01T00:00:00+00:00"
        app._feishu_last_restart_at = "2026-06-30T00:00:00+00:00"
        app._feishu_last_restart_error = "phase=start error=boom"

        snapshot = await app.channel_health_snapshot()

        health = snapshot["feishu"]
        assert health["connection_state"] == "restarting"
        assert health["restart_in_progress"] is True
        assert health["next_restart_at"] == "2026-07-01T00:00:00+00:00"
        assert health["last_restart_at"] == "2026-06-30T00:00:00+00:00"
        assert health["last_restart_error"] == "phase=start error=boom"

    asyncio.run(_run())


def test_feishu_restart_waits_for_busy_scheduler(monkeypatch) -> None:
    async def _run() -> None:
        adapter = _FakeFeishuAdapter()
        app = _app(adapter)
        states = [True, False]
        sleeps: list[float] = []

        class _BusyScheduler:
            def has_inflight_jobs(self) -> bool:
                return states.pop(0) if states else False

        async def fake_sleep(delay_s: float) -> bool:
            sleeps.append(delay_s)
            return True

        monkeypatch.setattr(app_mod, "FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS", 30)
        app._session_scheduler = _BusyScheduler()
        app._sleep_or_stop = fake_sleep

        assert await app._restart_feishu_when_idle_once() is True

        assert sleeps == [30]
        assert adapter.events == ["stop", "start"]

    asyncio.run(_run())


def test_feishu_restart_waits_for_queued_inbound_event(monkeypatch) -> None:
    async def _run() -> None:
        adapter = _FakeFeishuAdapter()
        app = _app(adapter)
        sleeps: list[float] = []
        app._ingress_queue.put_nowait(_inbound_event())

        async def fake_sleep(delay_s: float) -> bool:
            sleeps.append(delay_s)
            await app._ingress_queue.get()
            app._ingress_queue.task_done()
            return True

        monkeypatch.setattr(app_mod, "FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS", 30)
        app._sleep_or_stop = fake_sleep

        assert await app._restart_feishu_when_idle_once() is True

        assert sleeps == [30]
        assert adapter.events == ["stop", "start"]

    asyncio.run(_run())


def test_gateway_stop_shuts_down_feishu_restart_monitor(monkeypatch) -> None:
    async def _run() -> None:
        async def fake_close_all_network_clients() -> None:
            return None

        monkeypatch.setattr(app_mod, "FEISHU_GATEWAY_ENABLED", True)
        monkeypatch.setattr(app_mod, "FEISHU_WS_AUTO_RESTART_ENABLED", True)
        monkeypatch.setattr(app_mod, "FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS", 5400)
        monkeypatch.setattr(app_mod, "close_all_network_clients", fake_close_all_network_clients)
        monkeypatch.setattr(app_mod, "dispose", lambda: None)
        monkeypatch.setattr(app_mod, "reset_emit_handlers", lambda: None)

        app = _app(_FakeFeishuAdapter())
        app._started = True
        app._start_feishu_restart_monitor()
        task = app._feishu_restart_task

        assert task is not None
        assert not task.done()

        await app.stop()

        assert task.done()
        assert app._feishu_restart_task is None

    asyncio.run(_run())
