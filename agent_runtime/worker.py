"""Long-lived NDJSON adapter for the existing Python agent runtime."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterable, Awaitable, Callable, Mapping
from dataclasses import asdict, dataclass, is_dataclass
from datetime import date, datetime
import inspect
import json
import math
import os
import sys
from typing import Any
from uuid import uuid4

from jsonschema import ValidationError

from agent_runtime.emit_bus import (
    configure_emit_handler,
    configure_heartbeat_wake_handler,
    emit_final,
    emit_stream,
    reset_emit_handlers,
)
from agent_runtime.turn_handler import handle_unified_turn_job
from clients.auth.browser_auth_client import ensure_auth_sync
from gateway.session_scheduler import RunHandle
from shared.agent_io import AgentJob, EmitRequest, HeartbeatWakeRequest
from shared.agent_state import build_initial_agent_state
from shared.data_server.sync import sync_once as data_server_sync_once
from shared.db.client import (
    append_agent_session_pending_event,
    create_agent_session,
    create_response_route_context,
    dispose,
    has_agent_session_pending_events,
    init_schema,
    load_agent_session_record,
    load_response_route_context,
    pop_agent_session_pending_events,
    save_response_route_delivery_handle,
    save_response_route_patch,
    update_agent_session,
)
from shared.logging import get_logger, setup_logging
from shared.platform.context import SessionContext
from shared.protocol import validate_contract

logger = get_logger(__name__)


PROTOCOL_VERSION = "1"
REQUEST_KINDS = frozenset(
    {
        "worker.hello",
        "health",
        "session.ensure",
        "session.rebind",
        "response_route.upsert",
        "pending_events.pop",
        "pending_events.append",
        "turn.start",
        "turn.cancel",
        "turn.steer",
        "maintenance.run",
        "dashboard.query",
        "worker.shutdown",
    }
)
EVENT_KINDS = (
    "runtime.emit",
    "runtime.typing",
    "runtime.heartbeat_wake",
    "runtime.turn.completed",
)
MAINTENANCE_OPERATIONS = frozenset(
    {
        "mabang_erp_cookie_refresh",
        "data_server_sync",
    }
)

EnvelopeWriter = Callable[[dict[str, Any]], Awaitable[None]]
TurnHandler = Callable[..., Awaitable[Any]]
OperationHandler = Callable[[dict[str, Any]], Any]


class WorkerRequestError(RuntimeError):
    """A request failure that is safe to return as a protocol error."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(str(message or "request failed"))
        self.code = str(code or "invalid_request")


@dataclass(slots=True)
class _ActiveRun:
    run_id: str
    request_message_id: str
    job: AgentJob
    handle: RunHandle
    task: asyncio.Task[Any] | None = None
    closing: bool = False


def _contains_surrogate(value: str) -> bool:
    return any("\ud800" <= char <= "\udfff" for char in value)


def _safe_protocol_text(value: Any, *, strip: bool = True) -> str:
    if not isinstance(value, str) or _contains_surrogate(value):
        return ""
    return value.strip() if strip else value


def _safe_exception_message(exc: BaseException) -> str:
    try:
        message = _safe_protocol_text(str(exc), strip=False)
    except Exception:
        message = ""
    if message:
        return message
    return _safe_protocol_text(type(exc).__name__) or "Exception"


def _validate_unicode_scalars(value: Any) -> None:
    if isinstance(value, str):
        if _contains_surrogate(value):
            raise WorkerRequestError(
                "invalid_envelope",
                "worker envelope contains an invalid Unicode surrogate",
            )
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            _validate_unicode_scalars(key)
            _validate_unicode_scalars(item)
        return
    if isinstance(value, (list, tuple, set, frozenset)):
        for item in value:
            _validate_unicode_scalars(item)


def _require_text(payload: Mapping[str, Any], key: str) -> str:
    value = str(payload.get(key) or "").strip()
    if not value:
        raise WorkerRequestError("invalid_request", f"{key} is required")
    return value


def _require_object(payload: Mapping[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise WorkerRequestError("invalid_request", f"{key} must be an object")
    return dict(value)


def _to_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, str):
        if _contains_surrogate(value):
            raise WorkerRequestError(
                "invalid_result",
                "handler result contains an invalid Unicode surrogate",
            )
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise WorkerRequestError(
                "invalid_result",
                "handler result contains a non-finite number",
            )
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if is_dataclass(value) and not isinstance(value, type):
        return _to_jsonable(asdict(value))
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in value.items():
            safe_key = str(key)
            if _contains_surrogate(safe_key):
                raise WorkerRequestError(
                    "invalid_result",
                    "handler result contains an invalid Unicode surrogate",
                )
            result[safe_key] = _to_jsonable(item)
        return result
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_to_jsonable(item) for item in value]
    raise TypeError(f"value is not JSON serializable: {type(value).__name__}")


def _reject_json_constant(value: str) -> Any:
    raise ValueError(f"non-finite JSON number is not allowed: {value}")


def _default_mabang_refresh(_params: dict[str, Any]) -> dict[str, Any]:
    return dict(ensure_auth_sync(scope="erp") or {})


def _default_data_server_sync(params: dict[str, Any]) -> Any:
    gateway_id = str(params.get("gateway_id") or "").strip()
    return data_server_sync_once(gateway_id=gateway_id)


async def _default_session_get(params: dict[str, Any]) -> dict[str, Any]:
    session_id = _require_text(params, "session_id")
    return {"session": await load_agent_session_record(session_id)}


async def _default_pending_events_has(params: dict[str, Any]) -> dict[str, Any]:
    session_id = _require_text(params, "session_id")
    return {
        "session_id": session_id,
        "has_pending_events": bool(await has_agent_session_pending_events(session_id)),
    }


async def _default_response_route_get(params: dict[str, Any]) -> dict[str, Any]:
    response_route_id = _require_text(params, "response_route_id")
    return {"response_route": await load_response_route_context(response_route_id)}


DEFAULT_DASHBOARD_OPERATIONS: dict[str, OperationHandler] = {
    "session.get": _default_session_get,
    "pending_events.has": _default_pending_events_has,
    "response_route.get": _default_response_route_get,
}


class RuntimeWorker:
    """Protocol-v1 request dispatcher around existing runtime and DB APIs."""

    def __init__(
        self,
        *,
        write_envelope: EnvelopeWriter,
        turn_handler: TurnHandler = handle_unified_turn_job,
        maintenance_handlers: Mapping[str, OperationHandler] | None = None,
        dashboard_handlers: Mapping[str, OperationHandler] | None = None,
        initialize_storage: Callable[[], Any] = init_schema,
        close_storage: Callable[[], Any] = dispose,
        shutdown_timeout_s: float = 3.0,
    ) -> None:
        self._write_envelope = write_envelope
        self._turn_handler = turn_handler
        default_maintenance: dict[str, OperationHandler] = {
            "mabang_erp_cookie_refresh": _default_mabang_refresh,
            "data_server_sync": _default_data_server_sync,
        }
        for name, handler in dict(maintenance_handlers or {}).items():
            if name in MAINTENANCE_OPERATIONS:
                default_maintenance[name] = handler
        self._maintenance_handlers = default_maintenance
        self._dashboard_handlers = dict(DEFAULT_DASHBOARD_OPERATIONS)
        for name, handler in dict(dashboard_handlers or {}).items():
            if name not in DEFAULT_DASHBOARD_OPERATIONS:
                self._dashboard_handlers[name] = handler
        self._initialize_storage = initialize_storage
        self._close_storage = close_storage
        self._shutdown_timeout_s = max(0.1, float(shutdown_timeout_s))

        self._write_lock = asyncio.Lock()
        self._next_seq = 0
        self._active_runs: dict[str, _ActiveRun] = {}
        self._active_run_by_session: dict[str, str] = {}
        self._seen_run_ids: set[str] = set()
        self._completion_emitted: set[str] = set()
        self._completion_in_progress: set[str] = set()
        self._cancel_requested_run_ids: set[str] = set()
        self._request_tasks: set[asyncio.Task[None]] = set()
        self._ready = False
        self._started = False
        self._closed = False
        self.stop_requested = False

    async def start(self) -> None:
        if self._started:
            return
        if self._closed:
            raise RuntimeError("worker is already closed")
        await self._invoke_lifecycle(self._initialize_storage)
        configure_emit_handler(self._handle_emit_request)
        configure_heartbeat_wake_handler(self._handle_heartbeat_wake_request)
        self._started = True
        self._ready = True

    async def handle_line(self, line: str | bytes) -> None:
        if isinstance(line, bytes):
            text = line.decode("utf-8", errors="replace")
        else:
            text = str(line)
        if not text.strip():
            return
        try:
            message = json.loads(text, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, ValueError) as exc:
            await self._send_error(
                code="invalid_json",
                message=f"invalid JSON: {getattr(exc, 'msg', str(exc))}",
                request=None,
                request_kind="",
            )
            return
        await self.handle_message(message)

    async def handle_message(self, message: object) -> None:
        request = message if isinstance(message, dict) else None
        request_kind = _safe_protocol_text(request.get("kind")) if request is not None else ""
        try:
            _validate_unicode_scalars(message)
        except WorkerRequestError as exc:
            await self._send_error(
                code=exc.code,
                message=str(exc),
                request=request,
                request_kind="",
            )
            return
        try:
            validate_contract("worker_envelope", message)
        except ValidationError as exc:
            await self._send_error(
                code="invalid_envelope",
                message=f"invalid worker envelope: {exc.message}",
                request=request,
                request_kind=request_kind,
            )
            return

        assert request is not None
        if request_kind not in REQUEST_KINDS:
            await self._send_error(
                code="unsupported_request",
                message=f"unsupported request kind: {request_kind}",
                request=request,
                request_kind=request_kind,
            )
            return

        try:
            await self._dispatch(request_kind, request)
        except WorkerRequestError as exc:
            await self._send_error(
                code=exc.code,
                message=str(exc),
                request=request,
                request_kind=request_kind,
            )
        except ValidationError as exc:
            await self._send_error(
                code="invalid_request",
                message=exc.message,
                request=request,
                request_kind=request_kind,
            )
        except (TypeError, ValueError, RuntimeError) as exc:
            await self._send_error(
                code="invalid_request",
                message=str(exc) or type(exc).__name__,
                request=request,
                request_kind=request_kind,
            )
        except Exception as exc:
            logger.error(
                "[RuntimeWorker] request failed: kind=%s error=%s",
                request_kind,
                exc,
                exc_info=True,
            )
            await self._send_error(
                code="handler_error",
                message=str(exc) or type(exc).__name__,
                request=request,
                request_kind=request_kind,
            )

    async def serve(self, lines: AsyncIterable[str | bytes]) -> None:
        await self.start()
        try:
            async for line in lines:
                task = asyncio.create_task(
                    self.handle_line(line),
                    name="runtime-worker:request",
                )
                self._request_tasks.add(task)
                task.add_done_callback(self._on_request_task_done)
                await asyncio.sleep(0)
                if self.stop_requested:
                    break
        finally:
            self._request_cancel_active_runs()
            await self._drain_request_tasks()
            await self.shutdown()

    async def shutdown(self) -> None:
        if self._closed:
            return
        self._ready = False
        self.stop_requested = True

        self._request_cancel_active_runs()
        active = list(self._active_runs.values())
        tasks = [current.task for current in active if current.task is not None]
        if tasks:
            done, pending = await asyncio.wait(tasks, timeout=self._shutdown_timeout_s)
            _ = done
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

        reset_emit_handlers()
        try:
            await self._invoke_lifecycle(self._close_storage)
        finally:
            self._active_runs.clear()
            self._active_run_by_session.clear()
            self._closed = True

    def _request_cancel_active_runs(self) -> None:
        for current in list(self._active_runs.values()):
            self._request_run_cancel(current)

    def _request_run_cancel(self, current: _ActiveRun) -> bool:
        if current.closing:
            return False
        if current.run_id in self._cancel_requested_run_ids:
            return True
        self._cancel_requested_run_ids.add(current.run_id)
        current.handle.request_cancel()
        return True

    def _on_request_task_done(self, task: asyncio.Task[None]) -> None:
        self._request_tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is None:
            return
        self.stop_requested = True
        logger.error(
            "[RuntimeWorker] request task failed: %s",
            error,
            exc_info=error,
        )

    async def _drain_request_tasks(self) -> None:
        current_task = asyncio.current_task()
        tasks = [
            task
            for task in self._request_tasks
            if task is not current_task and not task.done()
        ]
        if not tasks:
            return
        _done, pending = await asyncio.wait(
            tasks,
            timeout=self._shutdown_timeout_s,
        )
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _dispatch(self, kind: str, request: dict[str, Any]) -> None:
        payload = dict(request["payload"])
        if kind == "worker.hello":
            await self._reply(
                request,
                {
                    "protocol_version": PROTOCOL_VERSION,
                    "worker_pid": os.getpid(),
                    "capabilities": {
                        "request_kinds": sorted(REQUEST_KINDS),
                        "event_kinds": list(EVENT_KINDS),
                        "maintenance_operations": sorted(MAINTENANCE_OPERATIONS),
                        "dashboard_operations": sorted(self._dashboard_handlers),
                    },
                },
            )
            return
        if kind == "health":
            await self._reply(
                request,
                {
                    "ready": bool(self._ready),
                    "active_run_count": len(self._active_runs),
                },
            )
            return
        if kind == "session.ensure":
            await self._session_ensure(request, payload)
            return
        if kind == "session.rebind":
            await self._session_rebind(request, payload)
            return
        if kind == "response_route.upsert":
            if str(payload.get("mode") or "").strip() == "patch":
                await self._response_route_patch(request, payload)
                return
            context = self._route_context(payload)
            await create_response_route_context(context)
            stored = await load_response_route_context(context.response_route_id)
            if stored is None:
                raise WorkerRequestError("invalid_request", "response route was not stored")
            await self._reply(request, {"response_route_id": context.response_route_id, "upserted": True})
            return
        if kind == "pending_events.append":
            session_id = _require_text(payload, "session_id")
            event = _require_object(payload, "event")
            updated = await append_agent_session_pending_event(session_id, event)
            if updated is None:
                raise WorkerRequestError("session_not_found", f"session not found: {session_id}")
            await self._reply(request, {"appended": True})
            return
        if kind == "pending_events.pop":
            session_id = _require_text(payload, "session_id")
            events = await pop_agent_session_pending_events(session_id)
            await self._reply(request, {"events": events})
            return
        if kind == "turn.start":
            await self._turn_start(request, payload)
            return
        if kind == "turn.cancel":
            await self._turn_cancel(request, payload)
            return
        if kind == "turn.steer":
            await self._turn_steer(request, payload)
            return
        if kind == "maintenance.run":
            operation = _require_text(payload, "operation")
            if operation not in MAINTENANCE_OPERATIONS:
                raise WorkerRequestError(
                    "unsupported_operation",
                    f"unsupported maintenance operation: {operation}",
                )
            params = payload.get("params", {})
            if not isinstance(params, dict):
                raise WorkerRequestError("invalid_request", "params must be an object")
            result = await self._invoke_operation(self._maintenance_handlers[operation], dict(params))
            await self._reply(request, {"result": _to_jsonable(result)})
            return
        if kind == "dashboard.query":
            operation = _require_text(payload, "operation")
            handler = self._dashboard_handlers.get(operation)
            if handler is None:
                raise WorkerRequestError(
                    "unsupported_operation",
                    f"unsupported dashboard operation: {operation}",
                )
            params = payload.get("params", {})
            if not isinstance(params, dict):
                raise WorkerRequestError("invalid_request", "params must be an object")
            result = await self._invoke_operation(handler, dict(params))
            await self._reply(request, {"result": _to_jsonable(result)})
            return
        if kind == "worker.shutdown":
            await self._reply(request, {"shutting_down": True})
            self.stop_requested = True
            return
        raise WorkerRequestError("unsupported_request", f"unsupported request kind: {kind}")

    async def _response_route_patch(
        self,
        request: dict[str, Any],
        payload: dict[str, Any],
    ) -> None:
        response_route_id = _require_text(payload, "response_route_id")
        stored = await load_response_route_context(response_route_id)
        if stored is None:
            raise WorkerRequestError(
                "response_route_not_found",
                f"response route not found: {response_route_id}",
            )

        patch = payload.get("patch", {})
        if not isinstance(patch, dict):
            raise WorkerRequestError("invalid_request", "patch must be an object")
        delivery_handle = payload.get("delivery_handle")
        if delivery_handle is not None and not isinstance(delivery_handle, dict):
            raise WorkerRequestError("invalid_request", "delivery_handle must be an object")
        if patch:
            await save_response_route_patch(response_route_id, dict(patch))
        if isinstance(delivery_handle, dict):
            platform_value = delivery_handle.get("platform")
            message_value = delivery_handle.get("platform_message_id")
            updated = await save_response_route_delivery_handle(
                response_route_id,
                platform=(str(platform_value).strip() if platform_value is not None else None),
                platform_message_id=(str(message_value).strip() if message_value is not None else None),
            )
            if not updated:
                raise WorkerRequestError(
                    "response_route_not_found",
                    f"response route not found: {response_route_id}",
                )
        await self._reply(
            request,
            {"response_route_id": response_route_id, "patched": True},
        )

    async def _session_ensure(
        self,
        request: dict[str, Any],
        payload: dict[str, Any],
    ) -> None:
        session_id = _require_text(payload, "session_id")
        source = _require_object(payload, "source")
        route_payload = payload.get("response_route")
        route_context = None
        if route_payload is not None:
            if not isinstance(route_payload, dict):
                raise WorkerRequestError("invalid_request", "response_route must be an object")
            route_context = self._route_context(route_payload, fallback_source=source)

        current = await load_agent_session_record(session_id)
        created = current is None
        if route_context is not None:
            await create_response_route_context(route_context)
        if current is None:
            await create_agent_session(
                session_id=session_id,
                source=source,
                state_data=build_initial_agent_state(
                    entry_text=str(payload.get("entry_text") or ""),
                ),
            )
        else:
            await update_agent_session(session_id, source=source, include_state=False)
        stored = await load_agent_session_record(session_id)
        if stored is None:
            raise WorkerRequestError("handler_error", f"session was not stored: {session_id}")
        await self._reply(
            request,
            {
                "session_id": stored.session_id,
                "source": stored.source,
                "created": created,
            },
        )

    async def _session_rebind(
        self,
        request: dict[str, Any],
        payload: dict[str, Any],
    ) -> None:
        session_id = _require_text(payload, "session_id")
        source = _require_object(payload, "source")
        route_payload = _require_object(payload, "response_route")
        if await load_agent_session_record(session_id) is None:
            raise WorkerRequestError("session_not_found", f"session not found: {session_id}")
        route_context = self._route_context(route_payload, fallback_source=source)
        await create_response_route_context(route_context)
        await update_agent_session(session_id, source=source, include_state=False)
        stored = await load_agent_session_record(session_id)
        if stored is None:
            raise WorkerRequestError("session_not_found", f"session not found: {session_id}")
        await self._reply(
            request,
            {
                "session_id": stored.session_id,
                "source": stored.source,
                "response_route_id": route_context.response_route_id,
            },
        )

    def _route_context(
        self,
        payload: Mapping[str, Any],
        *,
        fallback_source: Mapping[str, Any] | None = None,
    ) -> SessionContext:
        source_value = payload.get("source")
        if source_value is None:
            source = dict(fallback_source or {})
        elif isinstance(source_value, dict):
            source = dict(source_value)
        else:
            raise WorkerRequestError("invalid_request", "source must be an object")
        raw_data_value = payload.get("raw_data", {})
        if not isinstance(raw_data_value, dict):
            raise WorkerRequestError("invalid_request", "raw_data must be an object")

        response_route_id = _require_text(payload, "response_route_id")
        platform = str(payload.get("platform") or source.get("platform") or "").strip()
        user_id = str(
            payload.get("user_id")
            or source.get("user_id_alt")
            or source.get("user_id")
            or ""
        ).strip()
        conversation_id = str(payload.get("conversation_id") or source.get("chat_id") or "").strip()
        if not platform:
            raise WorkerRequestError("invalid_request", "platform is required")
        if not user_id:
            raise WorkerRequestError("invalid_request", "user_id is required")
        if not conversation_id:
            raise WorkerRequestError("invalid_request", "conversation_id is required")

        return SessionContext(
            platform=platform,
            user_input=str(payload.get("user_input") or ""),
            user_id=user_id,
            response_route_id=response_route_id,
            conversation_id=conversation_id,
            is_group=bool(
                payload.get("is_group")
                if "is_group" in payload
                else str(source.get("chat_type") or "").strip().lower() == "group"
            ),
            message_id=str(payload.get("message_id") or source.get("message_id") or "").strip(),
            sender_nick=str(payload.get("sender_nick") or source.get("user_name") or "").strip(),
            session_key=str(payload.get("session_key") or "").strip(),
            source=source,
            raw_data=dict(raw_data_value),
            user_content_blocks=[],
        )

    async def _turn_start(
        self,
        request: dict[str, Any],
        payload: dict[str, Any],
    ) -> None:
        validate_contract("agent_job", payload)
        run_id = str(request.get("run_id") or "").strip()
        job_id = str(payload.get("job_id") or "").strip()
        if not run_id:
            raise WorkerRequestError("invalid_request", "turn.start run_id is required")
        if run_id != job_id:
            raise WorkerRequestError("run_mismatch", "envelope run_id must equal AgentJob.job_id")
        if run_id in self._seen_run_ids:
            raise WorkerRequestError("duplicate_run", f"run_id already seen: {run_id}")

        job = AgentJob.from_dict(payload)
        active_for_session = self._active_run_by_session.get(job.session_id)
        if active_for_session is not None:
            raise WorkerRequestError(
                "session_busy",
                f"session already has an active run: {job.session_id}",
            )

        handle = RunHandle(
            session_id=job.session_id,
            job_id=job.job_id,
            response_route_id=job.response_route_id,
            origin_job=job,
        )
        current = _ActiveRun(
            run_id=run_id,
            request_message_id=str(request["message_id"]),
            job=job,
            handle=handle,
        )
        self._seen_run_ids.add(run_id)
        self._active_runs[run_id] = current
        self._active_run_by_session[job.session_id] = run_id

        await self._reply(
            request,
            {"accepted": True, "session_id": job.session_id},
        )
        task = asyncio.create_task(
            self._execute_turn(current),
            name=f"runtime-worker:{run_id}",
        )
        current.task = task
        handle.task = task

    async def _turn_cancel(
        self,
        request: dict[str, Any],
        payload: dict[str, Any],
    ) -> None:
        current = self._target_run(request, payload)
        if not self._request_run_cancel(current):
            raise WorkerRequestError(
                "run_closing",
                f"run is no longer accepting cancellation: {current.run_id}",
            )
        await self._reply(
            request,
            {"cancelled": True, "session_id": current.job.session_id},
        )

    async def _turn_steer(
        self,
        request: dict[str, Any],
        payload: dict[str, Any],
    ) -> None:
        current = self._target_run(request, payload)
        if current.closing:
            raise WorkerRequestError(
                "run_closing",
                f"run is no longer accepting steering: {current.run_id}",
            )
        text = _require_text(payload, "text")
        current.handle.push_steering(
            text,
            response_route_id=str(payload.get("response_route_id") or "").strip(),
            message_id=str(payload.get("message_id") or "").strip(),
        )
        await self._reply(
            request,
            {"accepted": True, "session_id": current.job.session_id},
        )

    def _target_run(
        self,
        request: Mapping[str, Any],
        payload: Mapping[str, Any],
    ) -> _ActiveRun:
        run_id = str(request.get("run_id") or "").strip()
        if not run_id:
            raise WorkerRequestError("invalid_request", "run_id is required")
        current = self._active_runs.get(run_id)
        if current is None:
            if run_id in self._seen_run_ids:
                raise WorkerRequestError(
                    "run_closing",
                    f"run is already closing or completed: {run_id}",
                )
            raise WorkerRequestError("run_not_found", f"active run not found: {run_id}")
        repeated_session_id = str(payload.get("session_id") or "").strip()
        if repeated_session_id and repeated_session_id != current.job.session_id:
            raise WorkerRequestError(
                "run_mismatch",
                "payload session_id does not match the active run",
            )
        return current

    async def _execute_turn(self, current: _ActiveRun) -> None:
        status = "completed"
        error_message = ""
        try:
            await self._turn_handler(
                job=current.job,
                run_handle=current.handle,
                emit_final=emit_final,
                emit_stream=emit_stream,
                emit_typing_indicator=self._emit_typing,
            )
            if current.handle.cancelled:
                status = "cancelled"
        except asyncio.CancelledError:
            self._request_run_cancel(current)
            status = "cancelled"
        except Exception as exc:
            status = "error"
            error_message = _safe_exception_message(exc)
            logger.error(
                "[RuntimeWorker] turn failed: session_id=%s run_id=%s error_type=%s error=%s",
                current.job.session_id,
                current.run_id,
                _safe_protocol_text(type(exc).__name__) or "Exception",
                error_message,
            )
        finally:
            current.closing = True
            remaining_steering = current.handle.drain_steering()
            include_remaining_steering = status != "cancelled" and not current.handle.cancelled
            if not include_remaining_steering:
                remaining_steering = []
            current.handle.cleanup_state = status
            try:
                await self._emit_completion_once(
                    current,
                    status=status,
                    error_message=error_message,
                    remaining_steering=(
                        remaining_steering
                        if include_remaining_steering
                        else None
                    ),
                )
            finally:
                self._active_runs.pop(current.run_id, None)
                self._cancel_requested_run_ids.discard(current.run_id)
                if self._active_run_by_session.get(current.job.session_id) == current.run_id:
                    self._active_run_by_session.pop(current.job.session_id, None)

    async def _handle_emit_request(self, request: EmitRequest) -> None:
        validate_contract("emit_request", request.to_dict())
        current = self._run_for_session(request.session_id)
        await self._send(
            kind="runtime.emit",
            payload=request.to_dict(),
            reply_to=current.request_message_id if current else None,
            run_id=current.run_id if current else None,
        )

    async def _handle_heartbeat_wake_request(self, request: HeartbeatWakeRequest) -> None:
        current = self._run_for_session(request.session_id)
        await self._send(
            kind="runtime.heartbeat_wake",
            payload=request.to_dict(),
            reply_to=current.request_message_id if current else None,
            run_id=current.run_id if current else None,
        )

    async def _emit_typing(self, **payload: Any) -> None:
        session_id = str(payload.get("session_id") or "").strip()
        current = self._run_for_session(session_id)
        await self._send(
            kind="runtime.typing",
            payload=dict(payload),
            reply_to=current.request_message_id if current else None,
            run_id=current.run_id if current else None,
        )

    def _run_for_session(self, session_id: str) -> _ActiveRun | None:
        run_id = self._active_run_by_session.get(str(session_id or "").strip())
        return self._active_runs.get(run_id) if run_id else None

    async def _emit_completion_once(
        self,
        current: _ActiveRun,
        *,
        status: str,
        error_message: str,
        remaining_steering: list[dict[str, str]] | None,
    ) -> None:
        if (
            current.run_id in self._completion_emitted
            or current.run_id in self._completion_in_progress
        ):
            return
        self._completion_in_progress.add(current.run_id)
        try:
            payload: dict[str, Any] = {
                "session_id": current.job.session_id,
                "status": str(status or "error"),
            }
            if error_message:
                payload["error"] = error_message
            if remaining_steering is not None:
                payload["remaining_steering"] = [
                    dict(item)
                    for item in remaining_steering
                ]
            await self._send(
                kind="runtime.turn.completed",
                payload=payload,
                reply_to=current.request_message_id,
                run_id=current.run_id,
            )
            self._completion_emitted.add(current.run_id)
        finally:
            self._completion_in_progress.discard(current.run_id)

    async def _reply(
        self,
        request: Mapping[str, Any],
        payload: dict[str, Any],
    ) -> None:
        await self._send(
            kind=f"{request['kind']}.result",
            payload=payload,
            reply_to=str(request["message_id"]),
            run_id=str(request.get("run_id") or "").strip() or None,
        )

    async def _send_error(
        self,
        *,
        code: str,
        message: str,
        request: Mapping[str, Any] | None,
        request_kind: str,
    ) -> None:
        reply_to = None
        run_id = None
        if request is not None:
            candidate_reply_to = _safe_protocol_text(request.get("message_id"))
            reply_to = candidate_reply_to or None
            candidate_run_id = _safe_protocol_text(request.get("run_id"))
            run_id = candidate_run_id or None
        safe_message = _safe_protocol_text(message, strip=False) or "request failed"
        safe_request_kind = _safe_protocol_text(request_kind)
        await self._send(
            kind="error",
            payload={
                "code": str(code or "handler_error"),
                "message": safe_message,
                "request_kind": safe_request_kind,
            },
            reply_to=reply_to,
            run_id=run_id,
        )

    async def _send(
        self,
        *,
        kind: str,
        payload: dict[str, Any],
        reply_to: str | None,
        run_id: str | None,
    ) -> None:
        async with self._write_lock:
            envelope = {
                "protocol_version": PROTOCOL_VERSION,
                "message_id": uuid4().hex,
                "reply_to": reply_to,
                "run_id": run_id,
                "seq": self._next_seq,
                "kind": str(kind or "").strip(),
                "payload": _to_jsonable(payload),
            }
            validate_contract("worker_envelope", envelope)
            self._next_seq += 1
            await self._write_envelope(envelope)

    @staticmethod
    async def _invoke_operation(handler: OperationHandler, params: dict[str, Any]) -> Any:
        if inspect.iscoroutinefunction(handler):
            return await handler(params)
        result = await asyncio.to_thread(handler, params)
        if inspect.isawaitable(result):
            return await result
        return result

    @staticmethod
    async def _invoke_lifecycle(handler: Callable[[], Any]) -> Any:
        result = handler()
        if inspect.isawaitable(result):
            return await result
        return result


async def _stdin_lines() -> AsyncIterable[bytes]:
    while True:
        line = await asyncio.to_thread(sys.stdin.buffer.readline)
        if not line:
            return
        yield line


async def _write_stdout_envelope(envelope: dict[str, Any]) -> None:
    encoded = json.dumps(
        envelope,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()


async def _run_stdio_worker() -> None:
    worker = RuntimeWorker(write_envelope=_write_stdout_envelope)
    await worker.serve(_stdin_lines())


def main() -> None:
    setup_logging()
    asyncio.run(_run_stdio_worker())


if __name__ == "__main__":
    main()


__all__ = [
    "EVENT_KINDS",
    "MAINTENANCE_OPERATIONS",
    "PROTOCOL_VERSION",
    "REQUEST_KINDS",
    "RuntimeWorker",
    "main",
]
