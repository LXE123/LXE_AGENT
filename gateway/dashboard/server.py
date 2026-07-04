from __future__ import annotations

import asyncio
import errno
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
        port_auto_fallback: bool = True,
        channel_health_snapshot: Callable[[], Awaitable[dict[str, dict[str, Any]]]] | None = None,
    ) -> None:
        self.host = str(host or "127.0.0.1").strip() or "127.0.0.1"
        self.requested_port = self._normalize_port(port)
        self.port = self.requested_port
        self.port_auto_fallback = bool(port_auto_fallback)
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
        self.port = self.requested_port
        sock, bind_error = self._bind_socket(self.requested_port)
        if sock is None and self.port_auto_fallback:
            fallback_sock, fallback_error = self._bind_socket(0)
            if fallback_sock is not None:
                sock = fallback_sock
                self.port = self._socket_port(sock)
                logger.warning(
                    "[Dashboard] port fallback: requested=%s actual=%s reason=%s",
                    self.requested_port,
                    self.port,
                    self._bind_error_text(bind_error),
                )
            else:
                self._error = (
                    f"{self._bind_error_text(bind_error)}; "
                    f"dynamic fallback failed: {self._bind_error_text(fallback_error)}"
                )
                logger.warning("[Dashboard] disabled: %s url=%s", self._error, self.url)
                return False
        if sock is None:
            self._error = self._bind_error_text(bind_error)
            logger.warning("[Dashboard] disabled: %s url=%s", self._error, self.url)
            return False
        self.port = self._socket_port(sock)
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
        self._task = asyncio.create_task(self._serve_guarded(server, [sock]), name="gateway:dashboard")
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

    @staticmethod
    def _normalize_port(port: int) -> int:
        try:
            value = int(port)
        except Exception:
            return 8765
        if value < 0 or value > 65535:
            return 8765
        return value

    def _bind_socket(self, port: int) -> tuple[socket.socket | None, BaseException | None]:
        family = socket.AF_INET6 if ":" in self.host else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((self.host, int(port)))
        except Exception as exc:
            sock.close()
            return None, exc
        sock.set_inheritable(True)
        return sock, None

    @staticmethod
    def _socket_port(sock: socket.socket) -> int:
        return int(sock.getsockname()[1])

    @staticmethod
    def _bind_error_text(exc: BaseException | None) -> str:
        if exc is None:
            return "bind failed"
        if isinstance(exc, OSError) and exc.errno in {errno.EADDRINUSE, errno.EACCES}:
            if exc.errno == errno.EADDRINUSE:
                return "address already in use"
            return "permission denied"
        return str(exc) or exc.__class__.__name__

    async def _serve_guarded(self, server: uvicorn.Server, sockets: list[socket.socket]) -> None:
        try:
            await server.serve(sockets=sockets)
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
        finally:
            for sock in sockets:
                sock.close()

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
