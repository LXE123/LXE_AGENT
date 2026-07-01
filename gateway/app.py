from __future__ import annotations

import asyncio
import importlib.util
import webbrowser
from datetime import datetime, timedelta, timezone
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler

from agent_runtime.emit_bus import configure_emit_handler, configure_heartbeat_wake_handler, reset_emit_handlers
from agent_runtime.turn_handler import handle_unified_turn_job
from clients.auth.browser_auth_client import ensure_auth_sync
from gateway.agent_queue import AgentQueue
from gateway.channel_registry import ChannelRegistry
from gateway.dashboard import DashboardServer
from gateway.dashboard.settings import dashboard_enabled, dashboard_host, dashboard_open_browser, dashboard_port
from gateway.emitter import GatewayEmitter
from gateway.heartbeat_wake import HeartbeatWakeManager
from gateway.models import InboundEvent
from gateway.session_scheduler import RunHandle, SessionScheduler
from gateway.session_router import SessionRouter
from gateway import config as gateway_settings
from platforms.feishu.config import (
    FEISHU_ENABLED,
    FEISHU_GATEWAY_ENABLED,
    FEISHU_WS_AUTO_RESTART_ENABLED,
    FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS,
    FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS,
    FEISHU_WS_AUTO_RESTART_RETRY_SECONDS,
    feishu_runtime_status,
    validate_feishu_runtime_config,
)
from shared.data_server.config import (
    data_server_enabled,
    data_server_sync_interval_seconds,
)
from shared.data_server.sync import sync_once as data_server_sync_once
from shared.db.client import (
    dispose,
    init_schema,
)
from shared.gateway_identity import gateway_identity_text
from shared.infra.net import close_all_network_clients
from shared.logging import logger


class GatewayApp:
    _WAIT_FOREVER_POLL_S = 0.5
    _STOP_TIMEOUTS = {
        "heartbeat_wake": 3.0,
        "session_scheduler": 3.0,
        "dispatcher_task": 3.0,
        "channel_registry": 8.0,
        "dashboard": 3.0,
        "feishu_auto_restart": 3.0,
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
        self._feishu_restart_task: asyncio.Task | None = None
        self._feishu_restart_lock = asyncio.Lock()
        self._feishu_restart_in_progress = False
        self._feishu_next_restart_at = ""
        self._feishu_last_restart_at = ""
        self._feishu_last_restart_error = ""
        self._stop_event = asyncio.Event()
        self._scheduler: BackgroundScheduler | None = None
        self._gateway_id = str(gateway_settings.GATEWAY_ID or "agent-gateway").strip() or "agent-gateway"
        self._session_scheduler = SessionScheduler(
            executor=self._execute_agent_job,
            max_concurrency=int(gateway_settings.AGENT_MAX_CONCURRENCY),
        )
        self._emitter = GatewayEmitter(registry=registry)
        self._heartbeat_wake = HeartbeatWakeManager(scheduler=self._session_scheduler)
        self._session_router = session_router
        self._session_router.bind_scheduler(self._session_scheduler)
        self._dashboard_server: DashboardServer | None = (
            DashboardServer(
                host=dashboard_host(),
                port=dashboard_port(),
                channel_health_snapshot=self.channel_health_snapshot,
            )
            if dashboard_enabled()
            else None
        )
        self._dashboard_browser_opened = False
        self._started = False

    async def channel_health_snapshot(self) -> dict[str, dict[str, Any]]:
        snapshot = await self._registry.health_snapshot()
        feishu_health = snapshot.get("feishu")
        if feishu_health is not None:
            snapshot["feishu"] = self._with_feishu_restart_health(feishu_health)
        return snapshot

    async def _handle_heartbeat_wake_request(self, request) -> None:
        await self._heartbeat_wake.handle_request(request)

    async def _execute_agent_job(self, job, run_handle: RunHandle) -> None:
        job_kind = str(getattr(job, "job_kind", "") or "turn").strip() or "turn"
        logger.info(
            "[Gateway] execute agent job inline: session_id=%s job_id=%s response_route_id=%s job_kind=%s",
            job.session_id,
            str(getattr(job, "job_id", "") or "").strip(),
            str(getattr(job, "response_route_id", "") or "").strip(),
            job_kind,
        )
        await handle_unified_turn_job(
            job,
            run_handle=run_handle,
            emit_final=self._emitter.emit_final,
            emit_stream=self._emitter.emit_stream,
            emit_typing_indicator=self._emitter.emit_typing_indicator,
        )

    @classmethod
    def from_config(cls) -> "GatewayApp":
        registry = ChannelRegistry()
        if not FEISHU_GATEWAY_ENABLED:
            logger.warning("⚠️ [Gateway] Feishu gateway disabled: FEISHU_GATEWAY_ENABLED=0")
            return cls(
                registry=registry,
                session_router=SessionRouter(registry=registry),
            )
        if not FEISHU_ENABLED:
            validate_feishu_runtime_config()
        if importlib.util.find_spec("lark_oapi") is None:
            raise RuntimeError(
                "Feishu is enabled, but dependency 'lark-oapi' is missing. "
                "Run scripts/install.ps1 or uv sync --frozen --all-groups before starting the gateway."
            )
        from platforms.feishu.gateway import FeishuStreamAdapter

        validate_feishu_runtime_config()
        registry.register(FeishuStreamAdapter())

        return cls(
            registry=registry,
            session_router=SessionRouter(registry=registry),
        )

    async def start(self) -> None:
        if self._started:
            return

        self._loop = asyncio.get_running_loop()
        init_schema()
        if self._dashboard_server is not None:
            await self._dashboard_server.start()
        self._log_feishu_runtime("Gateway", connects_gateway=True)
        configure_emit_handler(self._emitter.emit)
        configure_heartbeat_wake_handler(self._handle_heartbeat_wake_request)

        self._dispatcher_task = asyncio.create_task(self._dispatch_loop(), name="gateway:dispatch")
        for adapter in self._registry.list():
            adapter.set_inbound_sink(self.publish_from_adapter)
        try:
            await self._registry.start_all()
        except Exception:
            if self._dispatcher_task is not None:
                self._dispatcher_task.cancel()
                await asyncio.gather(self._dispatcher_task, return_exceptions=True)
                self._dispatcher_task = None
            await self._session_scheduler.stop()
            await self._registry.stop_all()
            if self._dashboard_server is not None:
                await self._dashboard_server.stop()
            reset_emit_handlers()
            raise

        self._scheduler = self._build_scheduler()
        self._scheduler.start()
        logger.info("⏰ [Scheduler] 后台定时任务已启动 (%s)", gateway_identity_text(self._gateway_id))
        await asyncio.to_thread(self._refresh_mabang_erp_cookie)

        health = await self.channel_health_snapshot()
        logger.info(
            "🚀 [Gateway] 启动成功 (%s mode=stream adapters=%s health=%s)",
            gateway_identity_text(self._gateway_id),
            self._registry.adapter_keys(),
            health,
        )
        if self._dashboard_server is not None and self._dashboard_server.state().get("started"):
            logger.info("🖥️ [Dashboard] available at %s", self._dashboard_server.url)
            await self._open_dashboard_browser()
        self._start_feishu_restart_monitor()
        self._started = True

    async def wait_forever(self) -> None:
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._WAIT_FOREVER_POLL_S)
            except asyncio.TimeoutError:
                continue

    def request_shutdown(self) -> None:
        self._stop_event.set()

    async def _open_dashboard_browser(self) -> None:
        dashboard = self._dashboard_server
        if dashboard is None or self._dashboard_browser_opened or not dashboard_open_browser():
            return
        url = self._dashboard_browser_url()
        try:
            opened = await asyncio.to_thread(webbrowser.open, url, new=2, autoraise=True)
        except Exception as exc:
            logger.warning("[Dashboard] browser open failed: url=%s error=%s", url, exc)
            return
        if not opened:
            logger.warning("[Dashboard] browser open returned false: url=%s", url)
            return
        self._dashboard_browser_opened = True
        logger.info("[Dashboard] browser opened: url=%s", url)

    def _dashboard_browser_url(self) -> str:
        dashboard = self._dashboard_server
        if dashboard is None:
            return ""
        host = str(getattr(dashboard, "host", "") or "").strip() or "127.0.0.1"
        port = int(getattr(dashboard, "port", 8765) or 8765)
        if host in {"0.0.0.0", "::", "[::]"}:
            host = "127.0.0.1"
        return f"http://{host}:{port}"

    async def stop(self) -> None:
        if not self._started and self._dispatcher_task is None:
            return

        self._stop_event.set()
        await self._await_stop_step(
            "feishu auto-restart monitor",
            self._stop_feishu_restart_monitor(),
            timeout_s=self._STOP_TIMEOUTS["feishu_auto_restart"],
        )
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
        if self._dispatcher_task is not None:
            self._dispatcher_task.cancel()
            await self._await_stop_step(
                "dispatcher task",
                asyncio.gather(self._dispatcher_task, return_exceptions=True),
                timeout_s=self._STOP_TIMEOUTS["dispatcher_task"],
            )
            self._dispatcher_task = None

        await self._await_stop_step(
            "channel adapters",
            self._registry.stop_all(timeout_s=5.0),
            timeout_s=self._STOP_TIMEOUTS["channel_registry"],
        )
        if self._dashboard_server is not None:
            await self._await_stop_step(
                "dashboard server",
                self._dashboard_server.stop(),
                timeout_s=self._STOP_TIMEOUTS["dashboard"],
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
        reset_emit_handlers()
        logger.info("🔒 [SQLite] 共享状态连接已释放")
        logger.info("👋 服务已完全停止，Bye!")
        self._started = False

    def _get_feishu_adapter(self):
        getter = getattr(self._registry, "get", None)
        if not callable(getter):
            return None
        try:
            return getter("feishu")
        except Exception:
            return None

    def _start_feishu_restart_monitor(self) -> None:
        if not FEISHU_GATEWAY_ENABLED:
            logger.info("[FeishuRestart] monitor not started: reason=feishu_gateway_disabled")
            return
        if not FEISHU_WS_AUTO_RESTART_ENABLED:
            logger.info("[FeishuRestart] monitor not started: reason=auto_restart_disabled")
            return
        if self._get_feishu_adapter() is None:
            logger.info("[FeishuRestart] monitor not started: reason=missing_adapter")
            return
        if self._feishu_restart_task is not None and not self._feishu_restart_task.done():
            return
        logger.info(
            "[FeishuRestart] monitor started: enabled=%s interval_s=%s idle_check_s=%s retry_s=%s",
            FEISHU_WS_AUTO_RESTART_ENABLED,
            FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS,
            FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS,
            FEISHU_WS_AUTO_RESTART_RETRY_SECONDS,
        )
        self._feishu_restart_task = asyncio.create_task(
            self._feishu_restart_loop(),
            name="gateway:feishu-auto-restart",
        )

    async def _stop_feishu_restart_monitor(self) -> None:
        task = self._feishu_restart_task
        self._feishu_restart_task = None
        if task is None:
            return
        if not task.done():
            self._stop_event.set()
            try:
                await asyncio.wait_for(
                    task,
                    timeout=max(0.1, self._STOP_TIMEOUTS["feishu_auto_restart"] / 2),
                )
                return
            except asyncio.TimeoutError:
                task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def _feishu_restart_loop(self) -> None:
        try:
            while not self._stop_event.is_set():
                self._feishu_next_restart_at = self._utc_after(FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS)
                logger.info(
                    "[FeishuRestart] next restart scheduled: interval_s=%s next_restart_at=%s",
                    FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS,
                    self._feishu_next_restart_at,
                )
                if not await self._sleep_or_stop(FEISHU_WS_AUTO_RESTART_INTERVAL_SECONDS):
                    return
                self._feishu_next_restart_at = ""
                logger.info("[FeishuRestart] restart due")
                while not self._stop_event.is_set():
                    if await self._restart_feishu_when_idle_once():
                        break
                    if self._stop_event.is_set():
                        return
                    self._feishu_next_restart_at = self._utc_after(FEISHU_WS_AUTO_RESTART_RETRY_SECONDS)
                    logger.info(
                        "[FeishuRestart] retry scheduled: retry_s=%s next_restart_at=%s",
                        FEISHU_WS_AUTO_RESTART_RETRY_SECONDS,
                        self._feishu_next_restart_at,
                    )
                    if not await self._sleep_or_stop(FEISHU_WS_AUTO_RESTART_RETRY_SECONDS):
                        return
        except asyncio.CancelledError:
            logger.info("[FeishuRestart] monitor stopped: gateway_stopping=%s", self._stop_event.is_set())
            raise

    async def _restart_feishu_when_idle_once(self) -> bool:
        adapter = self._get_feishu_adapter()
        if adapter is None:
            logger.warning("[FeishuRestart] restart deferred: reason=missing_adapter")
            return False
        if not await self._wait_for_feishu_restart_idle():
            return False

        if self._feishu_restart_lock.locked():
            logger.info("[FeishuRestart] restart deferred: reason=restart_already_in_progress")
            return False

        async with self._feishu_restart_lock:
            self._feishu_restart_in_progress = True
            self._feishu_last_restart_error = ""
            before_health = self._safe_adapter_health(adapter)
            logger.info("[FeishuRestart] restart starting: health_before=%s", before_health)
            try:
                logger.info("[FeishuRestart] stop starting")
                try:
                    await adapter.stop()
                except asyncio.CancelledError:
                    if self._is_gateway_cancelling():
                        raise
                    logger.warning(
                        "[FeishuRestart] adapter stop cancelled during SDK shutdown; continuing with start",
                        exc_info=True,
                    )
                except Exception as exc:
                    self._record_feishu_restart_failure("stop", exc)
                    return False
                else:
                    logger.info("[FeishuRestart] stop done")

                logger.info("[FeishuRestart] start starting")
                try:
                    await adapter.start()
                except asyncio.CancelledError:
                    if self._is_gateway_cancelling():
                        raise
                    exc = RuntimeError("adapter start cancelled outside gateway shutdown")
                    self._record_feishu_restart_failure("start", exc, exc_info=True)
                    return False
                except Exception as exc:
                    self._record_feishu_restart_failure("start", exc)
                    return False
            finally:
                self._feishu_restart_in_progress = False

            self._feishu_last_restart_at = self._utc_now()
            self._feishu_last_restart_error = ""
            after_health = self._safe_adapter_health(adapter)
            logger.info("[FeishuRestart] restart done: health_after=%s", after_health)
            return True

    async def _wait_for_feishu_restart_idle(self) -> bool:
        while not self._stop_event.is_set():
            if self._session_scheduler.has_inflight_jobs():
                logger.info(
                    "[FeishuRestart] restart deferred: reason=active_agent_jobs check_after_s=%s",
                    FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS,
                )
            elif not self._ingress_queue.empty():
                logger.info(
                    "[FeishuRestart] restart deferred: reason=queued_inbound_events check_after_s=%s",
                    FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS,
                )
            else:
                return True
            if not await self._sleep_or_stop(FEISHU_WS_AUTO_RESTART_IDLE_CHECK_SECONDS):
                return False
        return False

    async def _sleep_or_stop(self, delay_s: float) -> bool:
        if self._stop_event.is_set():
            return False
        try:
            await asyncio.wait_for(
                self._stop_event.wait(),
                timeout=max(0.0, float(delay_s)),
            )
        except asyncio.TimeoutError:
            return True
        return False

    @staticmethod
    def _safe_adapter_health(adapter) -> dict:
        try:
            return dict(adapter.health() or {})
        except Exception as exc:
            return {"error": str(exc)}

    def _with_feishu_restart_health(self, health: dict[str, Any]) -> dict[str, Any]:
        payload = dict(health or {})
        payload["restart_in_progress"] = self._feishu_restart_in_progress
        payload["last_restart_at"] = self._feishu_last_restart_at
        payload["last_restart_error"] = self._feishu_last_restart_error
        payload["next_restart_at"] = self._feishu_next_restart_at
        if self._feishu_restart_in_progress:
            payload["connection_state"] = "restarting"
        return payload

    def _record_feishu_restart_failure(self, phase: str, exc: BaseException, *, exc_info: bool = True) -> None:
        error = self._exception_text(exc)
        self._feishu_last_restart_error = f"phase={phase} error={error}"
        logger.warning(
            "[FeishuRestart] restart failed: phase=%s retry_s=%s error=%s",
            phase,
            FEISHU_WS_AUTO_RESTART_RETRY_SECONDS,
            error,
            exc_info=exc_info,
        )

    def _is_gateway_cancelling(self) -> bool:
        task = asyncio.current_task()
        return self._stop_event.is_set() or bool(task is not None and task.cancelling())

    @staticmethod
    def _exception_text(exc: BaseException) -> str:
        return str(exc) or exc.__class__.__name__

    @staticmethod
    def _utc_now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @classmethod
    def _utc_after(cls, delay_s: float) -> str:
        return (datetime.now(timezone.utc) + timedelta(seconds=max(0.0, float(delay_s)))).isoformat()

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
                    "[Gateway] dispatch failed: platform=%s event_type=%s",
                    event.platform,
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
        if data_server_enabled():
            interval_s = data_server_sync_interval_seconds()
            scheduler.add_job(
                self._schedule_data_server_sync,
                "interval",
                seconds=interval_s,
                id="agent_data_snapshot_sync",
                replace_existing=True,
                coalesce=True,
                max_instances=1,
                next_run_time=datetime.now(),
            )
            logger.info("📡 [DataServer] snapshot sync enabled: interval=%ss", interval_s)
        return scheduler

    def _schedule_data_server_sync(self) -> None:
        try:
            result = data_server_sync_once(gateway_id=self._gateway_id)
        except Exception as exc:
            logger.warning("[DataServer] snapshot upload failed: %s", exc, exc_info=True)
            return

        if result.uploaded:
            logger.info(
                "[DataServer] snapshot uploaded: sessions=%d messages=%d",
                result.sessions_received,
                result.messages_received,
            )
        elif result.skipped_reason and result.skipped_reason != "disabled":
            logger.info("[DataServer] snapshot skipped: reason=%s", result.skipped_reason)

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
            "🪶 [%s] Feishu config ready: app_id=%s api_host=%s bot_identity=probe",
            process_name,
            status.get("app_id_masked") or "<empty>",
            status.get("api_host") or "<empty>",
        )
        if not connects_gateway:
            logger.info(
                "ℹ️ [%s] Feishu WebSocket is started only by main.py gateway; this process only registers senders.",
                process_name,
            )
