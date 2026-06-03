from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace
from typing import Any

from aiohttp import web

from agent_runtime.ipc_client import configure_gateway_ipc
from agent_runtime.unified_worker import handle_unified_turn_job
from shared.agent_ipc import AgentJob
from shared.config import config
from shared.db.client import dispose as dispose_shared_state, init_schema
from shared.infra.net import close_all_network_clients
from shared.logging import logger


_FATAL_LOOP_WINERRORS = {121, 10054}


def _extract_winerror(exc: BaseException | None) -> int:
    if exc is None:
        return 0
    try:
        return int(getattr(exc, "winerror", 0) or 0)
    except Exception:
        return 0


def _is_fatal_windows_loop_error(context: dict[str, Any] | None) -> bool:
    if os.name != "nt":
        return False
    payload = dict(context or {})
    exc = payload.get("exception")
    if not isinstance(exc, BaseException):
        return False
    winerror = _extract_winerror(exc)
    if winerror not in _FATAL_LOOP_WINERRORS:
        return False
    message = str(payload.get("message") or "")
    handle_text = str(payload.get("handle") or "")
    text = f"{message} {handle_text}"
    return (
        "event loop self pipe" in text
        or "_read_from_self" in text
        or "_loop_self_reading" in text
    )


def _is_process_alive(pid: int) -> bool:
    safe_pid = int(pid or 0)
    if safe_pid <= 0:
        return True
    if os.name != "nt":
        try:
            os.kill(safe_pid, 0)
        except OSError:
            return False
        return True
    import ctypes

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x100000, False, safe_pid)
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0x00000102
    finally:
        kernel32.CloseHandle(handle)


class AgentControlServer:
    def __init__(
        self,
        *,
        worker_id: str,
        host: str,
        port: int,
        gateway_ipc_url: str,
        gateway_pid: int,
    ) -> None:
        self.worker_id = str(worker_id or "").strip()
        self.host = str(host or "127.0.0.1").strip() or "127.0.0.1"
        self.port = int(port or 0)
        self.gateway_ipc_url = str(gateway_ipc_url or "").rstrip("/")
        self.gateway_pid = int(gateway_pid or 0)
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._stop_event = asyncio.Event()
        self._semaphore = asyncio.Semaphore(max(1, int(config.WORKER_MAX_CONCURRENCY)))
        self._parent_watchdog_task: asyncio.Task | None = None
        self._fatal_exit_code = 0
        self._fatal_exit_reason = ""

    async def start(self) -> None:
        configure_gateway_ipc(self.gateway_ipc_url)
        app = web.Application()
        app.router.add_get("/health", self._handle_health)
        app.router.add_get("/workers", self._handle_workers)
        app.router.add_post("/execute", self._handle_execute)
        app.router.add_post("/shutdown", self._handle_shutdown)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, host=self.host, port=self.port)
        await self._site.start()
        self._parent_watchdog_task = asyncio.create_task(self._watch_parent(), name="agent-worker:parent-watch")

    async def stop(self) -> None:
        self._stop_event.set()
        task = self._parent_watchdog_task
        self._parent_watchdog_task = None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        site = self._site
        runner = self._runner
        self._site = None
        self._runner = None
        if site is not None:
            await site.stop()
        if runner is not None:
            await runner.cleanup()

    async def wait(self) -> None:
        await self._stop_event.wait()

    @property
    def fatal_exit_code(self) -> int:
        return int(self._fatal_exit_code or 0)

    def request_fatal_shutdown(self, *, reason: str, exit_code: int) -> None:
        if self._fatal_exit_code:
            return
        self._fatal_exit_code = max(1, int(exit_code or 1))
        self._fatal_exit_reason = str(reason or "").strip()
        logger.critical(
            "💥 [Worker] fatal event-loop error detected, worker will exit for supervisor restart: worker_id=%s code=%s reason=%s",
            self.worker_id,
            self._fatal_exit_code,
            self._fatal_exit_reason,
        )
        self._stop_event.set()

    async def _handle_health(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "worker_id": self.worker_id})

    async def _handle_workers(self, _request: web.Request) -> web.Response:
        return web.json_response(
            {
                "ok": True,
                "worker_id": self.worker_id,
                "gateway_ipc_url": self.gateway_ipc_url,
                "gateway_pid": self.gateway_pid,
            }
        )

    async def _handle_shutdown(self, _request: web.Request) -> web.Response:
        self._stop_event.set()
        return web.json_response({"ok": True})

    async def _handle_execute(self, request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        try:
            job = AgentJob.from_dict(dict(payload or {}))
            await self._execute_job(job)
        except Exception as exc:
            logger.error("[AgentWorker] execute failed: %s", exc, exc_info=True)
            return web.json_response({"ok": False, "error": str(exc)}, status=500)
        return web.json_response({"ok": True, "worker_id": self.worker_id})

    async def _execute_job(self, job: AgentJob) -> None:
        async with self._semaphore:
            fake_job = SimpleNamespace(
                payload={
                    "session_id": job.session_id,
                    "card_id": job.card_id,
                    "session_key": job.session_key,
                    "source": dict(job.source or {}),
                    "user_text": job.user_input,
                    "job_id": job.job_id,
                    "job_kind": job.job_kind,
                    "raw_data": dict(job.raw_data or {}),
                    "user_content_blocks": list(job.user_content_blocks or []),
                },
                job_id=job.job_id,
            )
            await handle_unified_turn_job(fake_job)

    async def _watch_parent(self) -> None:
        if self.gateway_pid <= 0:
            return
        while not self._stop_event.is_set():
            await asyncio.sleep(2.0)
            if _is_process_alive(self.gateway_pid):
                continue
            logger.warning("🛑 [AgentWorker] gateway process disappeared: pid=%s", self.gateway_pid)
            self._stop_event.set()
            return


async def main_async(
    *,
    worker_id: str = "",
    dashboard_host: str = "",
    dashboard_port: int = 0,
    gateway_ipc_url: str = "",
    gateway_pid: int = 0,
) -> None:
    init_schema()
    server = AgentControlServer(
        worker_id=worker_id,
        host=dashboard_host,
        port=dashboard_port,
        gateway_ipc_url=gateway_ipc_url,
        gateway_pid=gateway_pid,
    )
    loop = asyncio.get_running_loop()
    default_exception_handler = loop.get_exception_handler()
    fatal_loop_error_seen = False

    def _worker_exception_handler(loop_obj: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        nonlocal fatal_loop_error_seen
        if not fatal_loop_error_seen:
            if default_exception_handler is None:
                loop_obj.default_exception_handler(context)
            else:
                default_exception_handler(loop_obj, context)
        if fatal_loop_error_seen or not _is_fatal_windows_loop_error(context):
            return
        fatal_loop_error_seen = True
        exc = context.get("exception")
        winerror = _extract_winerror(exc if isinstance(exc, BaseException) else None)
        reason = str(context.get("message") or "fatal event loop error").strip() or "fatal event loop error"
        server.request_fatal_shutdown(reason=reason, exit_code=winerror or 1)

    loop.set_exception_handler(_worker_exception_handler)
    try:
        logger.info("👷 [Worker] Agent 执行服务就绪: worker_id=%s", server.worker_id)
        await server.start()
        await server.wait()
    except KeyboardInterrupt:
        logger.warning("🛑 [Worker] 接收到停止指令，准备退出")
    finally:
        loop.set_exception_handler(default_exception_handler)
        await server.stop()
        await close_all_network_clients()
        dispose_shared_state()
        logger.info("👋 [Worker] 已停止")
    if server.fatal_exit_code:
        raise SystemExit(server.fatal_exit_code)


def main(
    *,
    worker_id: str = "",
    dashboard_host: str = "",
    dashboard_port: int = 0,
    gateway_ipc_url: str = "",
    gateway_pid: int = 0,
) -> None:
    try:
        asyncio.run(
            main_async(
                worker_id=worker_id,
                dashboard_host=dashboard_host,
                dashboard_port=dashboard_port,
                gateway_ipc_url=gateway_ipc_url,
                gateway_pid=gateway_pid,
            )
        )
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
