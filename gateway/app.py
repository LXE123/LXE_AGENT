from __future__ import annotations

import asyncio
import importlib.util
import time
from concurrent.futures import CancelledError as FutureCancelledError
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler

from clients.auth.browser_auth_client import ensure_auth_sync
from gateway.agent_queue import AgentQueue
from gateway.agent_supervisor import AgentSupervisor
from gateway.channel_registry import ChannelRegistry
from gateway.heartbeat_wake import HeartbeatWakeManager
from gateway.ipc_server import GatewayIpcServer
from gateway.models import InboundEvent
from gateway.session_scheduler import SessionScheduler
from gateway.session_router import SessionRouter
from platforms.feishu.config import FEISHU_ENABLED, feishu_runtime_status, validate_feishu_runtime_config
from shared.config import config
from shared.agent_state import runtime_patch, runtime_state
from shared.db.client import (
    dispose,
    init_schema,
    load_agent_session,
    update_agent_session,
)
from shared.gateway_identity import gateway_identity_text
from shared.infra.net import close_all_network_clients
from shared.logging import logger
from shared.agent_sessions import AgentSessionStatus


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _adapter_label(adapter) -> str:
    platform = str(getattr(adapter, "platform", "") or "").strip() or "unknown"
    connector_key = str(getattr(adapter, "connector_key", "") or "").strip() or "unknown"
    return f"{platform}:{connector_key}"


class GatewayApp:
    _WAIT_FOREVER_POLL_S = 0.5
    _STOP_TIMEOUTS = {
        "heartbeat_wake": 3.0,
        "session_scheduler": 3.0,
        "agent_supervisor": 8.0,
        "dispatcher_task": 3.0,
        "ipc_server": 3.0,
        "channel_registry": 8.0,
        "network_clients": 5.0,
    }

    def __init__(
        self,
        *,
        registry: ChannelRegistry,
        session_router: SessionRouter,
    ) -> None:
        self._registry = registry
        self._ingress_queue = AgentQueue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._dispatcher_task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._scheduler: BackgroundScheduler | None = None
        self._gateway_id = str(config.GATEWAY_ID or "agent-gateway").strip() or "agent-gateway"
        self._session_scheduler = SessionScheduler(
            executor=self._execute_agent_job,
            max_concurrency=int(config.WORKER_MAX_CONCURRENCY),
        )
        self._heartbeat_wake = HeartbeatWakeManager(scheduler=self._session_scheduler)
        self._ipc_server = GatewayIpcServer(
            registry=registry,
            host=str(config.GATEWAY_IPC_HOST or "127.0.0.1").strip() or "127.0.0.1",
            port=int(config.GATEWAY_IPC_PORT),
            on_heartbeat_wake=self._handle_heartbeat_wake_request,
        )
        self._agent_supervisor = AgentSupervisor(
            project_root=PROJECT_ROOT,
            gateway_id=self._gateway_id,
            enabled=bool(config.GATEWAY_AUTO_START_WORKER),
            auto_open_dashboard=bool(config.GATEWAY_AUTO_OPEN_WORKER_DASHBOARD),
            dashboard_open_delay_s=int(config.GATEWAY_DASHBOARD_OPEN_DELAY_S),
            worker_dashboard_host=str(config.WORKER_DASHBOARD_HOST or "127.0.0.1"),
            worker_dashboard_port=int(config.WORKER_DASHBOARD_PORT),
            gateway_ipc_url=self._ipc_server.base_url,
        )
        self._session_router = session_router
        self._session_router.bind_scheduler(self._session_scheduler)
        self._adapter_recycle_lock = asyncio.Lock()
        self._started = False

    async def _handle_heartbeat_wake_request(self, request) -> None:
        await self._heartbeat_wake.handle_request(request)

    async def _execute_agent_job(self, job) -> None:
        session = await load_agent_session(job.session_id)
        if session is None:
            raise RuntimeError(f"agent session not found: {job.session_id}")
        job_kind = str(getattr(job, "job_kind", "") or "turn").strip() or "turn"
        _turn_id = str(getattr(job, "job_id", "") or "").strip()
        logger.info(
            "[Gateway] writing active_turn_id: session_id=%s turn_id=%s job_kind=%s",
            job.session_id, _turn_id, job_kind,
        )
        await update_agent_session(
            job.session_id,
            status=AgentSessionStatus.RUNNING,
            state_data_patch=runtime_patch(
                {
                    "active_turn_id": _turn_id,
                    "active_turn_started_at": int(time.time()),
                }
            ),
        )
        _verify = await load_agent_session(job.session_id)
        _verify_rt = runtime_state(getattr(_verify, "state_data", {}) or {}) if _verify else {}
        logger.info(
            "[Gateway] verify active_turn_id after write: session_id=%s stored=%s",
            job.session_id, _verify_rt.get("active_turn_id"),
        )
        try:
            await self._agent_supervisor.execute_agent_job(job)
        except Exception:
            await update_agent_session(
                job.session_id,
                status=AgentSessionStatus.WAITING_USER_INPUT,
            )
            raise

    @classmethod
    def from_config(cls) -> "GatewayApp":
        registry = ChannelRegistry()
        if not FEISHU_ENABLED:
            validate_feishu_runtime_config()
        if importlib.util.find_spec("lark_oapi") is None:
            raise RuntimeError(
                "Feishu is enabled, but dependency 'lark-oapi' is missing. "
                "Run scripts/install.ps1 or uv sync --frozen --all-groups before starting the gateway."
            )
        from platforms.feishu.gateway import FeishuStreamAdapter

        validate_feishu_runtime_config()
        registry.register(FeishuStreamAdapter(connector_key="agent"))

        return cls(
            registry=registry,
            session_router=SessionRouter(registry=registry),
        )

    async def start(self) -> None:
        if self._started:
            return

        self._loop = asyncio.get_running_loop()
        init_schema()
        self._log_feishu_runtime("Gateway", connects_gateway=True)

        self._dispatcher_task = asyncio.create_task(self._dispatch_loop(), name="gateway:dispatch")
        for adapter in self._registry.list():
            adapter.set_inbound_sink(self.publish_from_adapter)
        try:
            await self._ipc_server.start()
            await self._agent_supervisor.start()
            await self._registry.start_all()
        except Exception:
            await self._agent_supervisor.stop()
            if self._dispatcher_task is not None:
                self._dispatcher_task.cancel()
                await asyncio.gather(self._dispatcher_task, return_exceptions=True)
                self._dispatcher_task = None
            await self._session_scheduler.stop()
            await self._ipc_server.stop()
            await self._registry.stop_all()
            raise

        self._scheduler = self._build_scheduler()
        self._scheduler.start()
        logger.info("⏰ [Scheduler] 后台定时任务已启动 (%s)", gateway_identity_text(self._gateway_id))
        await asyncio.to_thread(self._refresh_mabang_erp_cookie)

        health = await self._registry.health_snapshot()
        logger.info(
            "🚀 [Gateway] 启动成功 (%s mode=stream connectors=%s health=%s)",
            gateway_identity_text(self._gateway_id),
            self._registry.connector_keys(),
            health,
        )
        self._started = True

    async def wait_forever(self) -> None:
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._WAIT_FOREVER_POLL_S)
            except asyncio.TimeoutError:
                continue

    def request_shutdown(self) -> None:
        self._stop_event.set()

    async def stop(self) -> None:
        if not self._started and self._dispatcher_task is None:
            return

        self._stop_event.set()
        await self._await_stop_step(
            "heartbeat wake manager",
            self._heartbeat_wake.stop(),
            timeout_s=self._STOP_TIMEOUTS["heartbeat_wake"],
        )
        await self._await_stop_step(
            "session scheduler",
            self._session_scheduler.stop(timeout_s=self._STOP_TIMEOUTS["session_scheduler"]),
            timeout_s=self._STOP_TIMEOUTS["session_scheduler"] + 0.5,
        )
        await self._await_stop_step(
            "agent supervisor",
            self._agent_supervisor.stop(),
            timeout_s=self._STOP_TIMEOUTS["agent_supervisor"],
        )
        if self._dispatcher_task is not None:
            self._dispatcher_task.cancel()
            await self._await_stop_step(
                "dispatcher task",
                asyncio.gather(self._dispatcher_task, return_exceptions=True),
                timeout_s=self._STOP_TIMEOUTS["dispatcher_task"],
            )
            self._dispatcher_task = None

        await self._await_stop_step(
            "gateway ipc server",
            self._ipc_server.stop(),
            timeout_s=self._STOP_TIMEOUTS["ipc_server"],
        )
        await self._await_stop_step(
            "channel adapters",
            self._registry.stop_all(timeout_s=5.0),
            timeout_s=self._STOP_TIMEOUTS["channel_registry"],
        )

        scheduler = self._scheduler
        self._scheduler = None
        if scheduler is not None and scheduler.running:
            logger.info("🛑 [Gateway] stopping apscheduler")
            scheduler.shutdown(wait=False)
            logger.info("🔒 [Scheduler] 调度器已停止")

        await self._await_stop_step(
            "network clients",
            close_all_network_clients(),
            timeout_s=self._STOP_TIMEOUTS["network_clients"],
        )

        logger.info("🛑 [Gateway] stopping local shared-state store")
        dispose()
        logger.info("🔒 [SQLite] 共享状态连接已释放")
        logger.info("👋 服务已完全停止，Bye!")
        self._started = False

    async def _await_stop_step(
        self,
        label: str,
        awaitable,
        *,
        timeout_s: float,
    ) -> None:
        logger.info("🛑 [Gateway] stopping %s (timeout=%.1fs)", label, float(timeout_s))
        try:
            await asyncio.wait_for(awaitable, timeout=max(0.1, float(timeout_s)))
        except asyncio.TimeoutError:
            logger.warning("⚠️ [Gateway] stop step timed out: %s (timeout=%.1fs)", label, float(timeout_s))
        except Exception as exc:
            logger.warning("⚠️ [Gateway] stop step failed: %s error=%s", label, exc)
        else:
            logger.info("✅ [Gateway] stopped %s", label)

    def publish_from_adapter(self, event: InboundEvent):
        if self._loop is None:
            raise RuntimeError("gateway loop not initialized")

        self._loop.call_soon_threadsafe(self._ingress_queue.put_nowait, event)
        return None

    async def _dispatch_loop(self) -> None:
        while True:
            event = await self._ingress_queue.get()
            try:
                await self._session_router.route_message(event)
            except Exception:
                logger.error(
                    "[Gateway] dispatch failed: platform=%s connector=%s event_type=%s",
                    event.platform,
                    event.connector_key,
                    event.event_type,
                    exc_info=True,
                )
            finally:
                self._ingress_queue.task_done()

    def _build_scheduler(self) -> BackgroundScheduler:
        scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
        scheduler.add_job(
            GatewayApp._refresh_mabang_erp_cookie,
            "interval",
            hours=2,
            id="mabang_erp_cookie_refresh",
            replace_existing=True,
            coalesce=True,
            max_instances=1,
        )
        if bool(config.GATEWAY_ADAPTER_RECYCLE_ENABLED):
            scheduler.add_job(
                self._schedule_adapter_recycle,
                "interval",
                hours=1,
                id="gateway_adapter_recycle",
                replace_existing=True,
                coalesce=True,
                max_instances=1,
            )
            logger.info("♻️ [Gateway] adapter recycle enabled: interval=60m")
        if bool(config.GATEWAY_ADAPTER_WATCHDOG_ENABLED):
            scheduler.add_job(
                self._schedule_adapter_watchdog,
                "interval",
                minutes=1,
                id="gateway_adapter_watchdog",
                replace_existing=True,
                coalesce=True,
                max_instances=1,
            )
            logger.info("👀 [Gateway] adapter watchdog enabled: interval=1m")
        return scheduler

    def _schedule_adapter_recycle(self) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            logger.info("[Gateway] adapter recycle skipped: gateway loop unavailable")
            return
        future = asyncio.run_coroutine_threadsafe(self._run_adapter_recycle(), loop)
        future.add_done_callback(self._log_adapter_recycle_failure)

    def _schedule_adapter_watchdog(self) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            logger.info("[Gateway] adapter watchdog skipped: gateway loop unavailable")
            return
        future = asyncio.run_coroutine_threadsafe(self._run_adapter_watchdog(), loop)
        future.add_done_callback(self._log_adapter_watchdog_failure)

    @staticmethod
    def _log_adapter_recycle_failure(future) -> None:
        try:
            future.result()
        except FutureCancelledError:
            return
        except Exception as exc:
            logger.error("[Gateway] adapter recycle task failed: %s", exc, exc_info=True)

    @staticmethod
    def _log_adapter_watchdog_failure(future) -> None:
        try:
            future.result()
        except FutureCancelledError:
            return
        except Exception as exc:
            logger.error("[Gateway] adapter watchdog task failed: %s", exc, exc_info=True)

    def _get_adapter_recycle_lock(self) -> asyncio.Lock:
        lock = getattr(self, "_adapter_recycle_lock", None)
        if lock is None:
            lock = asyncio.Lock()
            self._adapter_recycle_lock = lock
        return lock

    async def _run_adapter_recycle(self) -> None:
        lock = self._get_adapter_recycle_lock()
        if lock.locked():
            logger.info("[Gateway] adapter recycle skipped: previous recycle still running")
            return

        async with lock:
            if not self._started or self._stop_event.is_set():
                logger.info("[Gateway] adapter recycle skipped: gateway is stopping or not started")
                return
            if self._session_scheduler.has_inflight_jobs():
                logger.info("[Gateway] adapter recycle skipped: inflight agent jobs detected")
                return

            adapters = list(self._registry.list())
            labels = [_adapter_label(adapter) for adapter in adapters]
            failed: list[str] = []
            logger.info("[Gateway] adapter recycle start: adapters=%s", labels)
            for adapter in adapters:
                label = _adapter_label(adapter)
                try:
                    await adapter.stop()
                    await adapter.start()
                except Exception as exc:
                    failed.append(label)
                    logger.warning(
                        "[Gateway] adapter recycle failed: adapter=%s error=%s",
                        label,
                        exc,
                        exc_info=True,
                    )
            if failed:
                logger.warning(
                    "[Gateway] adapter recycle finished with failures: adapters=%s failed=%s",
                    labels,
                    failed,
                )
                return
            logger.info("[Gateway] adapter recycle complete: adapters=%s", labels)

    async def _run_adapter_watchdog(self) -> None:
        lock = self._get_adapter_recycle_lock()
        if lock.locked():
            logger.info("[Gateway] adapter watchdog skipped: previous recycle still running")
            return

        async with lock:
            if not self._started or self._stop_event.is_set():
                logger.info("[Gateway] adapter watchdog skipped: gateway is stopping or not started")
                return

            for adapter in list(self._registry.list()):
                label = _adapter_label(adapter)
                health = dict(adapter.health() or {})
                thread_alive = bool(health.get("thread_alive", health.get("running")))
                connection_alive = bool(health.get("connection_alive"))
                connection_state = str(health.get("connection_state") or "").strip() or (
                    "connected" if connection_alive else "disconnected"
                )
                if thread_alive:
                    if not connection_alive:
                        logger.info(
                            "[Gateway] adapter watchdog: connection not alive but thread running, "
                            "trusting SDK auto-reconnect: adapter=%s connection_state=%s",
                            label,
                            connection_state,
                        )
                    continue
                logger.warning(
                    "[Gateway] adapter watchdog detected dead thread: adapter=%s thread_alive=%s connection_alive=%s connection_state=%s",
                    label,
                    thread_alive,
                    connection_alive,
                    connection_state,
                )
                try:
                    logger.info("[Gateway] adapter watchdog restarting: adapter=%s", label)
                    await adapter.stop()
                    await adapter.start()
                except Exception as exc:
                    logger.warning(
                        "[Gateway] adapter watchdog restart failed: adapter=%s error=%s",
                        label,
                        exc,
                        exc_info=True,
                    )
                    continue
                logger.info("[Gateway] adapter watchdog restart succeeded: adapter=%s", label)

    @staticmethod
    def _refresh_mabang_erp_cookie() -> None:
        try:
            payload = ensure_auth_sync(scope="erp")
        except Exception as exc:
            logger.error("❌ [Scheduler] 马帮 ERP Cookie 刷新失败: %s", exc)
            return
        source = str(payload.get("source") or "").strip() or "unknown"
        logger.info("🔐 [Scheduler] 马帮 ERP Cookie 已获取: source=%s", source)

    @staticmethod
    def _log_feishu_runtime(process_name: str, *, connects_gateway: bool) -> None:
        status = feishu_runtime_status()
        missing_required = list(status.get("missing_required") or [])
        if missing_required:
            logger.warning(
                "⚠️ [%s] Feishu disabled: missing_required=%s",
                process_name,
                ",".join(missing_required),
            )
            return

        logger.info(
            "🪶 [%s] Feishu config ready: app_id=%s api_host=%s bot_open_id=%s",
            process_name,
            status.get("app_id_masked") or "<empty>",
            status.get("api_host") or "<empty>",
            "set" if status.get("bot_open_id_configured") else "missing",
        )
        if not status.get("bot_open_id_configured"):
            logger.warning(
                "⚠️ [%s] FEISHU_BOT_OPEN_ID not configured; group @ mention filtering will be skipped.",
                process_name,
            )
        if not connects_gateway:
            logger.info(
                "ℹ️ [%s] Feishu WebSocket is started only by main.py gateway; this process only registers senders.",
                process_name,
            )
