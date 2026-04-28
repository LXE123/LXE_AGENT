from __future__ import annotations

import asyncio
from dataclasses import asdict, is_dataclass
from datetime import datetime
import os
import subprocess
import sys
import webbrowser
from pathlib import Path

from shared.infra.net import HttpSessionPurpose, build_child_env, get_aiohttp_session
from shared.logging import logger


class AgentSupervisor:
    def __init__(
        self,
        *,
        project_root: Path,
        worker_entry: str = "worker_main.py",
        gateway_id: str,
        enabled: bool,
        auto_open_dashboard: bool,
        dashboard_open_delay_s: int,
        worker_dashboard_host: str,
        worker_dashboard_port: int,
        gateway_ipc_url: str,
    ) -> None:
        self._project_root = Path(project_root)
        self._worker_entry = str(worker_entry or "worker_main.py").strip() or "worker_main.py"
        self._process: subprocess.Popen | None = None
        self._gateway_id = str(gateway_id or "gateway").strip() or "gateway"
        self._enabled = bool(enabled)
        self._auto_open_dashboard = bool(auto_open_dashboard)
        self._dashboard_open_delay_s = max(0, int(dashboard_open_delay_s))
        self._worker_dashboard_host = str(worker_dashboard_host or "127.0.0.1").strip() or "127.0.0.1"
        self._worker_dashboard_port = int(worker_dashboard_port)
        self._gateway_ipc_url = str(gateway_ipc_url or "").rstrip("/")
        self._worker_id = f"{self._gateway_id}:worker"
        self._restart_lock = asyncio.Lock()
        self._stopping = False

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def worker_id(self) -> str:
        return self._worker_id

    @property
    def ready(self) -> bool:
        process = self._process
        return process is not None and process.poll() is None

    async def start(self) -> None:
        if not self.enabled:
            logger.info("ℹ️ [Gateway] Worker auto-start disabled; Gateway will not supervise a local worker.")
            return
        self._stopping = False
        await self.ensure_running(reason="gateway-start")

        if self._auto_open_dashboard:
            await asyncio.sleep(float(self._dashboard_open_delay_s))
            self._open_dashboard()

    async def stop(self) -> None:
        self._stopping = True
        process = self._process
        self._process = None
        if process is None or process.poll() is not None:
            return

        logger.info("🔒 [Gateway] 正在停止 Worker ...")
        try:
            await self._request_shutdown()
        except Exception as exc:
            logger.warning("⚠️ [Gateway] Worker graceful shutdown 请求失败: %s", exc)
            process.terminate()
        try:
            await asyncio.to_thread(process.wait, 5)
        except Exception:
            logger.warning("⚠️ [Gateway] Worker 未在 5s 内退出，强制结束。")
            process.kill()
            await asyncio.to_thread(process.wait, 2)

    async def execute_claimed_job(self, job) -> None:
        await self.ensure_running(reason="execute-job")
        payload = self._serialize_job(job)
        try:
            await self._post_execute(payload)
        except Exception as exc:
            process = self._process
            if process is None or process.poll() is None:
                raise
            logger.warning(
                "⚠️ [Gateway] Worker execute 请求期间已退出，准备重启后重试一次: worker_id=%s code=%s error=%s",
                self._worker_id,
                process.returncode,
                exc,
            )
            await self.ensure_running(reason=f"execute-retry:{process.returncode}")
            await self._post_execute(payload)

    async def execute_agent_job(self, job) -> None:
        await self.execute_claimed_job(job)

    async def ensure_running(self, *, reason: str) -> None:
        if not self.enabled:
            raise RuntimeError("worker auto-start disabled")
        async with self._restart_lock:
            if self._stopping:
                raise RuntimeError("worker supervisor is stopping")
            process = self._process
            if process is not None and process.poll() is None:
                return
            if process is not None:
                logger.warning(
                    "⚠️ [Gateway] Worker 已退出，准备重启: worker_id=%s code=%s reason=%s",
                    self._worker_id,
                    process.returncode,
                    reason,
                )
            await self._spawn_worker_locked()

    async def _wait_until_ready(self) -> None:
        process = self._process
        if process is None:
            return
        url = self._health_url()
        for _ in range(30):
            if process.poll() is not None:
                raise RuntimeError(f"worker exited early with code={process.returncode}")
            if await self._probe_health(url):
                logger.info("✅ [Gateway] Worker 已就绪: %s", self._dashboard_url())
                return
            await asyncio.sleep(0.5)
        raise RuntimeError(f"worker control endpoint did not become ready: {url}")

    async def _probe_health(self, url: str) -> bool:
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        try:
            async with session.get(url, timeout=1) as response:
                if response.status != 200:
                    return False
                payload = await response.json()
        except Exception:
            return False
        return bool(payload.get("ok")) and str(payload.get("worker_id") or "").strip() == self._worker_id

    async def _request_shutdown(self) -> None:
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        try:
            async with session.post(self._shutdown_url(), json={}, timeout=3) as response:
                await response.read()
                if response.status != 200:
                    raise RuntimeError(f"status={response.status}")
        except Exception:
            process = self._process
            if process is not None and process.poll() is None:
                process.terminate()

    async def _spawn_worker_locked(self) -> None:
        logger.info("🧱 [Gateway] 正在拉起 Worker ...")
        env = build_child_env()
        self._process = subprocess.Popen(
            [
                sys.executable,
                self._worker_entry,
                "--worker-id",
                self._worker_id,
                "--dashboard-host",
                self._worker_dashboard_host,
                "--dashboard-port",
                str(self._worker_dashboard_port),
                "--gateway-ipc-url",
                self._gateway_ipc_url,
                "--gateway-pid",
                str(os.getpid()),
            ],
            cwd=str(self._project_root),
            env=env,
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )
        await self._wait_until_ready()

    async def _post_execute(self, payload: dict) -> None:
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        async with session.post(self._execute_url(), json=payload, timeout=None) as response:
            body = await response.text()
            if response.status != 200:
                raise RuntimeError(f"worker execute failed: status={response.status} body={body[:200]}")

    def _dashboard_url(self) -> str:
        host = self._worker_dashboard_host
        if host in {"", "0.0.0.0"}:
            host = "127.0.0.1"
        return f"http://{host}:{self._worker_dashboard_port}/workers"

    def _health_url(self) -> str:
        host = self._worker_dashboard_host
        if host in {"", "0.0.0.0"}:
            host = "127.0.0.1"
        return f"http://{host}:{self._worker_dashboard_port}/health"

    def _execute_url(self) -> str:
        host = self._worker_dashboard_host
        if host in {"", "0.0.0.0"}:
            host = "127.0.0.1"
        return f"http://{host}:{self._worker_dashboard_port}/execute"

    def _shutdown_url(self) -> str:
        host = self._worker_dashboard_host
        if host in {"", "0.0.0.0"}:
            host = "127.0.0.1"
        return f"http://{host}:{self._worker_dashboard_port}/shutdown"

    def _open_dashboard(self) -> None:
        url = self._dashboard_url()
        logger.info("🪟 [Gateway] 打开 Worker Dashboard: %s", url)
        try:
            webbrowser.open(url)
        except Exception as exc:
            logger.warning("⚠️ [Gateway] 打开 Worker Dashboard 失败: %s", exc)

    @staticmethod
    def _serialize_job(job) -> dict:
        raw = asdict(job) if is_dataclass(job) else dict(job or {})

        def _convert(value):
            if isinstance(value, datetime):
                return value.isoformat()
            if isinstance(value, dict):
                return {str(k): _convert(v) for k, v in value.items()}
            if isinstance(value, list):
                return [_convert(item) for item in value]
            return value

        return _convert(raw)
