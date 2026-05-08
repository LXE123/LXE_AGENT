from __future__ import annotations

from typing import Any, Callable

from services.agent_cli.browser.amazon_common.login_verify import verify_seller_central_login
from services.browser.workflows.amazon_fba_common import (
    WorkflowBrowserSession,
    exception_text as _exception_text,
    merge_workflow_contexts as _merge_context,
    not_ready_result as _not_ready_result,
    resolve_workflow_session as _resolve_session,
    selected_store as _selected_store,
    workflow_context as _context,
    workflow_result as _result_with_details,
)


WorkflowEventWriter = Callable[[dict[str, Any]], None]


def run_login_verify_workflow(
    *,
    session: WorkflowBrowserSession | None = None,
    runtime: Any = None,
    payload: dict[str, Any],
    event_writer: WorkflowEventWriter,
    verify_fn: Callable[..., dict[str, Any]] = verify_seller_central_login,
) -> dict[str, Any]:
    _ = event_writer
    try:
        workflow_session = _resolve_session(session=session, runtime=runtime)
    except Exception as exc:
        return _result_with_details(
            params_ready=True,
            finished=False,
            exception=_exception_text(exc),
            context=_context(
                site=str(payload.get("site") or "").strip(),
                consignment_no=str(payload.get("consignment_no") or "").strip(),
                transport_mode=str(payload.get("transport_mode") or "").strip(),
            ),
        )

    site = str(payload.get("site") or "").strip()
    consignment_no = str(payload.get("consignment_no") or "").strip()
    transport_mode = str(payload.get("transport_mode") or "").strip()
    timeout_sec = max(30, int(payload.get("timeout_sec") or 180))
    base_context = _context(
        session=workflow_session,
        site=site,
        consignment_no=consignment_no,
        transport_mode=transport_mode,
    )

    workflow_context = _merge_context(
        base_context,
        _context(
            session=workflow_session,
            site=site,
            consignment_no=consignment_no,
            transport_mode=transport_mode,
        ),
    )
    selected_store = _selected_store(workflow_session)
    if not str(selected_store.get("store_id") or "").strip():
        return _not_ready_result(
            context=workflow_context,
            exception="当前没有明确选中的店铺",
        )

    try:
        verify_payload = dict(verify_fn(workflow_session.driver, timeout_seconds=timeout_sec) or {})
    except Exception as exc:
        return _result_with_details(
            params_ready=True,
            finished=False,
            exception=_exception_text(exc),
            context=workflow_context,
        )

    click_count = int(verify_payload.get("click_count") or 0)
    notice = str(verify_payload.get("notice") or "").strip()
    if click_count and notice:
        notice = f"{notice}，共点击 {click_count} 次"
    if bool(verify_payload.get("manual_required")):
        return _result_with_details(
            params_ready=True,
            finished=False,
            exception=notice or "登录验证未完成，请用户手动操作",
            notice=notice,
            context=workflow_context,
        )
    return _result_with_details(
        params_ready=True,
        finished=True,
        notice=notice,
        context=workflow_context,
    )


__all__ = ["run_login_verify_workflow"]
