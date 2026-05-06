from __future__ import annotations

import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from shared.agent_state import ensure_agent_state, runtime_patch_from_state
from shared.logging import logger

from agent_runtime.packs.browser.driver_session import attached_driver, select_first_normal_tab
from agent_runtime.packs.browser.dispatcher import dispatch_ziniao_browser, dispatch_ziniao_page
from agent_runtime.packs.browser.models import ExecuteToolResult
from agent_runtime.packs.browser.tools import build_browser_tool_call
from services.browser.models.protocol import emit_progress
from services.browser.store.store_session_service import StoreSessionService
from services.browser.workflows.amazon_fba_common import WorkflowBrowserSession


def _artifacts_dir(session_id: str) -> Path:
    return (
        Path(__file__).resolve().parents[3]
        / "services"
        / "browser"
        / "artifacts"
        / "amazon_store_agent"
        / str(session_id or "unknown")
    )


def _tool_target_text(tool_call) -> str:
    arguments = dict(tool_call.arguments or {})
    for key in ("store_id", "ref", "url", "action"):
        value = str(arguments.get(key) or "").strip()
        if value:
            return value
    return ""


@contextmanager
def _page_workflow_session(runtime: Any, *, store_id: str, output_dir: Path) -> Iterator[WorkflowBrowserSession]:
    service = StoreSessionService()
    workflow_session: WorkflowBrowserSession | None = None

    try:
        try:
            store_session = service.ensure_store_session(store_id)
            driver_context = attached_driver(
                browser_path=str(store_session.browser_path or "").strip(),
                debugging_port=int(store_session.debugging_port or 0),
            )
            driver = driver_context.__enter__()
        except RuntimeError:
            store_session = service.ensure_store_session(store_id, force_restart=True)
            driver_context = attached_driver(
                browser_path=str(store_session.browser_path or "").strip(),
                debugging_port=int(store_session.debugging_port or 0),
            )
            driver = driver_context.__enter__()
        try:
            select_first_normal_tab(driver)
            workflow_session = WorkflowBrowserSession(
                driver=driver,
                state_data=ensure_agent_state(getattr(runtime, "state_data", {}) or {}),
                output_dir=output_dir,
                session_id=str(getattr(runtime, "session_id", "") or "").strip(),
                store_id=str(store_session.browser_oauth or "").strip(),
                store_name=str(store_session.browser_name or "").strip(),
                download_path=str(store_session.download_path or "").strip(),
                browser_path=str(store_session.browser_path or "").strip(),
            )
            yield workflow_session
        finally:
            driver_context.__exit__(None, None, None)
    finally:
        if workflow_session is not None:
            runtime.state_data = ensure_agent_state(workflow_session.state_data)


def _raw_result(
    runtime: Any,
    *,
    started_at: float,
    tool_name: str,
    summary: str,
    verification: dict[str, Any] | None = None,
    after_snapshot: dict[str, Any] | None = None,
    screenshot_path: str = "",
    payload: dict[str, Any] | None = None,
    failure_reason: str = "",
    error_code: str = "",
    clicked_element: dict[str, Any] | None = None,
) -> ExecuteToolResult:
    return ExecuteToolResult(
        tool_name=str(tool_name or "").strip(),
        success=not bool(error_code),
        summary=str(summary or "").strip(),
        verification=dict(verification or {}),
        after_snapshot=dict(after_snapshot or {}),
        screenshot_path=str(screenshot_path or "").strip(),
        payload=dict(payload or {}),
        failure_reason=str(failure_reason or "").strip(),
        error_code=str(error_code or "").strip(),
        clicked_element=dict(clicked_element or {}),
        latency_ms=int((time.perf_counter() - started_at) * 1000),
        state_data=runtime_patch_from_state(getattr(runtime, "state_data", {}) or {}),
    )


def _allows_screenshot(tool_call) -> bool:
    if str(tool_call.name or "").strip() != "ziniao_page":
        return False
    action = str(dict(tool_call.arguments or {}).get("action") or "").strip().lower()
    return action == "browser_vision"


def _finalize_payload(
    runtime: Any,
    *,
    started_at: float,
    tool_call,
    payload: dict[str, Any],
) -> ExecuteToolResult:
    screenshot_path = str(payload.get("screenshot_path") or "").strip()
    if not _allows_screenshot(tool_call):
        screenshot_path = ""

    clicked_element = dict(payload.get("clicked_element") or {})
    action_name = str(tool_call.arguments.get("action") or "").strip()
    if tool_call.name == "ziniao_page" and action_name == "browser_click" and clicked_element:
        logger.info(
            "🖱️ [AmazonStoreAgent] clicked element: session_id=%s aid=%s tag=%s text=%s",
            runtime.session_id,
            str(clicked_element.get("aid") or "").strip(),
            str(clicked_element.get("tag") or "").strip(),
            str(clicked_element.get("text") or "").strip(),
        )

    return _raw_result(
        runtime,
        started_at=started_at,
        tool_name=tool_call.name,
        summary=str(payload.get("summary") or "").strip(),
        verification=dict(payload.get("verification") or {}),
        after_snapshot=dict(payload.get("after_snapshot") or {}),
        screenshot_path=screenshot_path,
        payload=dict(payload.get("payload") or {}),
        clicked_element=clicked_element,
    )


def _failure_result(
    runtime: Any,
    *,
    started_at: float,
    tool_call,
    user_goal: str,
    failure_reason: str,
    error_code: str,
    after_snapshot: dict[str, Any] | None = None,
) -> ExecuteToolResult:
    return _raw_result(
        runtime,
        started_at=started_at,
        tool_name=tool_call.name,
        summary="",
        after_snapshot=after_snapshot or None,
        failure_reason=failure_reason,
        error_code=error_code,
        payload={
            "action": str(tool_call.arguments.get("action") or "").strip(),
            "user_goal": user_goal,
        },
    )


def execute_browser_tool(runtime: Any, *, tool_name: str, arguments: dict[str, Any] | None = None) -> ExecuteToolResult:
    started_at = time.perf_counter()
    tool_call = build_browser_tool_call(name=tool_name, arguments=arguments or {})
    user_goal = _tool_target_text(tool_call) or f"{tool_call.name}:{tool_call.arguments.get('action') or ''}".strip(":")
    output_dir = _artifacts_dir(runtime.session_id)

    if tool_call.name == "ziniao_browser":
        emit_progress(f"正在执行紫鸟浏览器动作: {tool_call.arguments.get('action')}")
        try:
            payload = dispatch_ziniao_browser(runtime, dict(tool_call.arguments or {}), output_dir=output_dir)
        except Exception as exc:
            return _failure_result(
                runtime,
                started_at=started_at,
                tool_call=tool_call,
                user_goal=user_goal,
                failure_reason=str(exc).strip(),
                error_code="browser_action_failed",
            )
        return _finalize_payload(
            runtime,
            started_at=started_at,
            tool_call=tool_call,
            payload=payload,
        )

    emit_progress(f"正在执行紫鸟页面动作: {tool_call.arguments.get('action')}")
    store_id = str(tool_call.arguments.get("store_id") or "").strip()
    if not store_id:
        return _failure_result(
            runtime,
            started_at=started_at,
            tool_call=tool_call,
            user_goal=user_goal,
            failure_reason="missing store_id",
            error_code="invalid_arguments",
        )

    try:
        with _page_workflow_session(runtime, store_id=store_id, output_dir=output_dir) as session:
            before_snapshot = session.snapshot()
            payload = dispatch_ziniao_page(
                session,
                dict(tool_call.arguments or {}),
                output_dir=output_dir,
                before_snapshot=before_snapshot,
            )
    except Exception as exc:
        return _failure_result(
            runtime,
            started_at=started_at,
            tool_call=tool_call,
            user_goal=user_goal,
            failure_reason=str(exc).strip(),
            error_code="page_action_failed",
        )

    return _finalize_payload(
        runtime,
        started_at=started_at,
        tool_call=tool_call,
        payload=payload,
    )


__all__ = ["execute_browser_tool"]
