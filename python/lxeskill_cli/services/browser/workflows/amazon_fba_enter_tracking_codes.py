from __future__ import annotations

from typing import Any, Callable

from services.agent_cli.browser.amazon_common.region_switch import normalize_site_code
from services.agent_cli.browser.amazon_common.shipment_tracking import (
    enter_tracking_codes,
    probe_tracking_input_ready,
)
from services.browser.models.protocol import bind_event_writer
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


def run_enter_tracking_codes_workflow(
    *,
    session: WorkflowBrowserSession | None = None,
    runtime: Any = None,
    payload: dict[str, Any],
    event_writer: WorkflowEventWriter,
    probe_ready_fn: Callable[..., dict[str, Any]] = probe_tracking_input_ready,
    enter_tracking_codes_fn: Callable[..., dict[str, Any]] = enter_tracking_codes,
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

    if not site:
        return _not_ready_result(context=base_context, exception="site 不能为空")
    if not consignment_no:
        return _not_ready_result(context=base_context, exception="consignment_no 不能为空")
    if not transport_mode:
        return _not_ready_result(context=base_context, exception="transport_mode 不能为空")
    try:
        target_site = normalize_site_code(site)
    except Exception as exc:
        return _not_ready_result(context=base_context, exception=_exception_text(exc))

    workflow_context = _merge_context(
        base_context,
        _context(
            session=workflow_session,
            site=target_site,
            consignment_no=consignment_no,
            transport_mode=transport_mode,
        ),
    )

    with bind_event_writer(lambda _payload: None):
        selected_store = _selected_store(workflow_session)
        if not str(selected_store.get("store_id") or "").strip():
            return _not_ready_result(
                context=workflow_context,
                exception="当前没有明确选中的店铺",
            )
        ready_payload = dict(probe_ready_fn(workflow_session, timeout_seconds=60) or {})
        if not bool(ready_payload.get("ready")):
            return _not_ready_result(
                context=workflow_context,
                exception="当前页面未进入输入追踪编码流程",
            )

        try:
            result_payload = dict(
                enter_tracking_codes_fn(workflow_session, timeout_seconds=timeout_sec) or {}
            )
        except Exception as exc:
            return _result_with_details(
                params_ready=True,
                finished=False,
                exception=_exception_text(exc),
                context=workflow_context,
            )

        return _result_with_details(
            params_ready=True,
            finished=True,
            notice=str(result_payload.get("notice") or "").strip(),
            context=workflow_context,
        )


__all__ = ["run_enter_tracking_codes_workflow"]
