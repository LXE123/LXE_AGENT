from __future__ import annotations

import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from shared.logging import get_logger
from shared.process_lock import InterProcessLockTimeout
from shared.workspace import artifact_path

from services.browser.tools.dispatcher import dispatch_ziniao_browser, dispatch_ziniao_page
from services.browser.tools.models import ExecuteToolResult
from services.browser.tools.schema import build_browser_tool_call
from services.browser.models.protocol import emit_progress
from services.browser.store.store_driver_session import store_driver_session
from services.browser.workflows.amazon_fba_common import WorkflowBrowserSession

logger = get_logger(__name__)


def _artifacts_dir(session_id: str) -> Path:
    return artifact_path("browser", "amazon_store_agent", str(session_id or "unknown"))


def _tool_target_text(tool_call) -> str:
    arguments = dict(tool_call.arguments or {})
    for key in ("store_id", "ref", "url", "action"):
        value = str(arguments.get(key) or "").strip()
        if value:
            return value
    return ""


@contextmanager
def _page_workflow_session(runtime: Any, *, store_id: str, output_dir: Path) -> Iterator[WorkflowBrowserSession]:
    with store_driver_session(store_id) as (store_session, driver):
        yield WorkflowBrowserSession(
            driver=driver,
            output_dir=output_dir,
            session_id=str(getattr(runtime, "session_id", "") or "").strip(),
            store_id=str(store_session.browser_oauth or "").strip(),
            store_name=str(store_session.browser_name or "").strip(),
            download_path=str(store_session.download_path or "").strip(),
            browser_path=str(store_session.browser_path or "").strip(),
        )


def _raw_result(
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
    )


def _allows_screenshot(tool_call) -> bool:
    if str(tool_call.name or "").strip() != "ziniao_page":
        return False
    arguments = dict(tool_call.arguments or {})
    steps = list(arguments.get("steps") or [])
    if steps:
        return str(dict(steps[-1] or {}).get("action") or "").strip().lower() == "browser_vision"
    action = str(arguments.get("action") or "").strip().lower()
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
        logger.debug(
            "🖱️ [AmazonStoreAgent] clicked element: session_id=%s aid=%s tag=%s text=%s",
            runtime.session_id,
            str(clicked_element.get("aid") or "").strip(),
            str(clicked_element.get("tag") or "").strip(),
            str(clicked_element.get("text") or "").strip(),
        )

    return _raw_result(
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
    *,
    started_at: float,
    tool_call,
    user_goal: str,
    failure_reason: str,
    error_code: str,
    after_snapshot: dict[str, Any] | None = None,
) -> ExecuteToolResult:
    return _raw_result(
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


_OBSERVE_ONLY_ACTIONS = {"browser_snapshot", "browser_vision"}


def _execute_page_batch(
    runtime: Any,
    *,
    started_at: float,
    tool_call,
    user_goal: str,
    output_dir: Path,
) -> ExecuteToolResult:
    arguments = dict(tool_call.arguments or {})
    store_id = str(arguments.get("store_id") or "").strip()
    steps = [dict(step or {}) for step in list(arguments.get("steps") or [])]
    emit_progress(f"正在执行紫鸟页面批量动作: {len(steps)} 步")

    step_results: list[dict[str, Any]] = []
    failed_step = 0
    failure_reason = ""
    screenshot_path = ""
    final_snapshot: dict[str, Any] = {}
    final_snapshot_summary = ""
    last_action = ""

    try:
        with _page_workflow_session(runtime, store_id=store_id, output_dir=output_dir) as session:
            previous_after: dict[str, Any] = {}
            for index, step in enumerate(steps, start=1):
                last_action = str(step.get("action") or "").strip().lower()
                before_snapshot = previous_after or session.snapshot()
                try:
                    payload = dispatch_ziniao_page(
                        session,
                        step,
                        output_dir=output_dir,
                        before_snapshot=before_snapshot,
                    )
                except Exception as exc:
                    failed_step = index
                    failure_reason = str(exc).strip()
                    step_results.append({
                        "index": index,
                        "action": last_action,
                        "ok": False,
                        "error": failure_reason,
                    })
                    break
                previous_after = dict(payload.get("after_snapshot") or {})
                if last_action == "browser_vision":
                    screenshot_path = str(payload.get("screenshot_path") or "").strip()
                step_results.append({
                    "index": index,
                    "action": last_action,
                    "ok": True,
                    "summary": str(payload.get("summary") or "").strip(),
                })
            final_snapshot = previous_after
            # A trailing snapshot keeps the model's refs fresh after page
            # mutations, and doubles as the recovery view after a failed step.
            if failed_step or last_action not in _OBSERVE_ONLY_ACTIONS:
                try:
                    snapshot_payload = dispatch_ziniao_page(
                        session,
                        {"action": "browser_snapshot", "store_id": store_id},
                        output_dir=output_dir,
                        before_snapshot=previous_after,
                    )
                    final_snapshot = dict(snapshot_payload.get("after_snapshot") or {})
                    final_snapshot_summary = str(snapshot_payload.get("summary") or "").strip()
                except Exception:
                    logger.warning("batch final snapshot failed", exc_info=True)
    except InterProcessLockTimeout as exc:
        return _failure_result(
            started_at=started_at,
            tool_call=tool_call,
            user_goal=user_goal,
            failure_reason=str(exc).strip(),
            error_code="store_busy",
        )
    except Exception as exc:
        return _failure_result(
            started_at=started_at,
            tool_call=tool_call,
            user_goal=user_goal,
            failure_reason=str(exc).strip(),
            error_code="page_action_failed",
        )

    executed = sum(1 for item in step_results if item.get("ok"))
    completed = failed_step == 0
    if completed:
        summary = f"批量执行完成: {executed}/{len(steps)} 步"
    else:
        summary = f"批量执行在第 {failed_step}/{len(steps)} 步停止: {failure_reason}"
    meaningful_change = any(
        item.get("ok") and str(item.get("action") or "") not in _OBSERVE_ONLY_ACTIONS
        for item in step_results
    )
    aggregate: dict[str, Any] = {
        "summary": summary,
        "verification": {"action": "batch", "meaningful_change": meaningful_change},
        "after_snapshot": final_snapshot,
        "screenshot_path": screenshot_path,
        "payload": {
            "action": "batch",
            "store_id": store_id,
            "total_steps": len(steps),
            "completed": completed,
            "steps": step_results,
        },
    }
    if failed_step:
        aggregate["payload"]["failed_step"] = failed_step
        aggregate["payload"]["failure_reason"] = failure_reason
    if final_snapshot_summary:
        aggregate["payload"]["final_snapshot_summary"] = final_snapshot_summary
    return _finalize_payload(
        runtime,
        started_at=started_at,
        tool_call=tool_call,
        payload=aggregate,
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
        except InterProcessLockTimeout as exc:
            return _failure_result(
                started_at=started_at,
                tool_call=tool_call,
                user_goal=user_goal,
                failure_reason=str(exc).strip(),
                error_code="store_busy",
            )
        except Exception as exc:
            return _failure_result(
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

    if list(tool_call.arguments.get("steps") or []):
        return _execute_page_batch(
            runtime,
            started_at=started_at,
            tool_call=tool_call,
            user_goal=user_goal,
            output_dir=output_dir,
        )

    emit_progress(f"正在执行紫鸟页面动作: {tool_call.arguments.get('action')}")
    store_id = str(tool_call.arguments.get("store_id") or "").strip()
    if not store_id:
        return _failure_result(
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
    except InterProcessLockTimeout as exc:
        return _failure_result(
            started_at=started_at,
            tool_call=tool_call,
            user_goal=user_goal,
            failure_reason=str(exc).strip(),
            error_code="store_busy",
        )
    except Exception as exc:
        return _failure_result(
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
