from __future__ import annotations

import asyncio
import socket

from gateway.app import GatewayApp
from gateway.dashboard.server import DashboardServer


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_dashboard_server_starts_and_stops_on_free_port() -> None:
    async def _run() -> None:
        server = DashboardServer(host="127.0.0.1", port=_free_port())

        assert await server.start() is True
        state = server.state()
        assert state["enabled"] is True
        assert state["started"] is True
        assert state["running"] is True
        assert state["error"] == ""

        await server.stop()
        assert server.state()["running"] is False

    asyncio.run(_run())


def test_dashboard_server_returns_false_when_port_is_occupied() -> None:
    async def _run() -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen(1)
            port = int(sock.getsockname()[1])
            server = DashboardServer(host="127.0.0.1", port=port)

            assert await server.start() is False
            state = server.state()
            assert state["started"] is False
            assert state["running"] is False
            assert state["error"] == "address already in use"

            await server.stop()

    asyncio.run(_run())


def test_dashboard_server_swallows_uvicorn_system_exit(monkeypatch) -> None:
    class FakeUvicornServer:
        started = False
        should_exit = False

        def __init__(self, _config) -> None:
            self.install_signal_handlers = None

        async def serve(self) -> None:
            raise SystemExit(1)

    monkeypatch.setattr("gateway.dashboard.server.uvicorn.Server", FakeUvicornServer)

    async def _run() -> None:
        server = DashboardServer(host="127.0.0.1", port=_free_port())

        assert await server.start() is False
        state = server.state()
        assert state["started"] is False
        assert state["running"] is False
        assert "uvicorn exited" in state["error"]

        await server.stop()

    asyncio.run(_run())


def test_gateway_start_continues_when_dashboard_start_fails(monkeypatch) -> None:
    class FakeDashboardServer:
        url = "http://127.0.0.1:8765"
        stopped = False

        async def start(self) -> bool:
            return False

        async def stop(self) -> None:
            self.stopped = True

        def state(self) -> dict:
            return {
                "enabled": True,
                "url": self.url,
                "started": False,
                "running": False,
                "error": "address already in use",
            }

    class FakeRegistry:
        def list(self) -> list:
            return []

        async def start_all(self) -> None:
            return None

        async def stop_all(self, timeout_s: float | None = None) -> None:
            return None

        async def health_snapshot(self) -> dict:
            return {}

        def adapter_keys(self) -> list:
            return []

    class FakeRouter:
        def bind_scheduler(self, _scheduler) -> None:
            return None

        async def route_message(self, _event) -> None:
            return None

    class FakeScheduler:
        running = False

        def start(self) -> None:
            self.running = True

        def shutdown(self, wait: bool = False) -> None:
            self.running = False

    monkeypatch.setattr("gateway.app.init_schema", lambda: None)
    monkeypatch.setattr("gateway.app.dispose", lambda: None)
    monkeypatch.setattr("gateway.app.GatewayApp._build_scheduler", lambda _self: FakeScheduler())
    monkeypatch.setattr("gateway.app.GatewayApp._refresh_mabang_erp_cookie", staticmethod(lambda: None))
    monkeypatch.setattr(
        "gateway.app.feishu_runtime_status",
        lambda: {
            "missing_required": [],
            "app_id_masked": "cli_xxx",
            "api_host": "https://open.feishu.cn",
            "bot_open_id_configured": True,
        },
    )

    async def _run() -> None:
        app = GatewayApp(registry=FakeRegistry(), session_router=FakeRouter())
        app._dashboard_server = FakeDashboardServer()

        await app.start()
        assert app._started is True
        await app.stop()

    asyncio.run(_run())
