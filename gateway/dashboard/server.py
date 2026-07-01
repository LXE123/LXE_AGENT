from __future__ import annotations

import asyncio
import socket
from collections.abc import Awaitable, Callable
from typing import Any

import uvicorn

from shared.logging import logger

from .api import create_dashboard_app


class DashboardServer:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        channel_health_snapshot: Callable[[], Awaitable[dict[str, dict[str, Any]]]] | None = None,
    ) -> None:
        self.host = str(host or "127.0.0.1").strip() or "127.0.0.1"
        self.port = max(1, int(port or 8765))
        self._channel_health_snapshot = channel_health_snapshot
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None
        self._error = ""

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    async def start(self) -> bool:
        if self._task is not None and not self._task.done():
            return True
        self._error = ""
        if not self._port_available():
            self._error = "address already in use"
            logger.warning("[Dashboard] disabled: address already in use url=%s", self.url)
            return False
        config = uvicorn.Config(
            create_dashboard_app(channel_health_snapshot=self._channel_health_snapshot),
            host=self.host,
            port=self.port,
            log_level="info",
            lifespan="on",
        )
        server = uvicorn.Server(config)
        server.install_signal_handlers = lambda: None
        self._server = server
        self._task = asyncio.create_task(self._serve_guarded(server), name="gateway:dashboard")
        for _ in range(50):
            if bool(getattr(server, "started", False)):
                logger.info("[Dashboard] started: url=%s", self.url)
                return True
            if self._task.done():
                await self._task
                return False
            await asyncio.sleep(0.1)
        logger.warning("[Dashboard] start not confirmed after timeout: url=%s", self.url)
        return False

    def _port_available(self) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.bind((self.host, self.port))
        except OSError:
            return False
        return True

    async def _serve_guarded(self, server: uvicorn.Server) -> None:
        try:
            await server.serve()
        except asyncio.CancelledError:
            raise
        except SystemExit as exc:
            self._error = f"uvicorn exited with status {exc.code}"
            self._server = None
            logger.warning("[Dashboard] disabled: %s url=%s", self._error, self.url)
        except Exception as exc:
            self._error = str(exc) or exc.__class__.__name__
            self._server = None
            logger.warning("[Dashboard] disabled: start failed url=%s error=%s", self.url, self._error, exc_info=True)

    async def stop(self) -> None:
        task = self._task
        server = self._server
        self._task = None
        self._server = None
        if server is not None:
            server.should_exit = True
        if task is None:
            return
        try:
            await task
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("[Dashboard] server stopped with error: %s", exc)
        else:
            logger.info("[Dashboard] stopped")

    def state(self) -> dict[str, Any]:
        server = self._server
        task = self._task
        return {
            "enabled": True,
            "url": self.url,
            "started": bool(getattr(server, "started", False)) if server is not None else False,
            "running": task is not None and not task.done(),
            "error": self._error,
        }


__all__ = ["DashboardServer"]
