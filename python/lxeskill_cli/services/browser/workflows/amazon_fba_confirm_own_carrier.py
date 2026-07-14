from __future__ import annotations

from typing import Any, Callable

from services.agent_cli.browser.amazon_common.own_carrier import (
    confirm_own_carrier_shipment,
    probe_own_carrier_ready,
)
from services.agent_cli.browser.amazon_common.region_switch import normalize_site_code
from services.browser.models.protocol import bind_event_writer
from services.browser.workflows.amazon_fba_common import (
    WorkflowBrowserSession,
    exception_text as _exception_text,
    file_path_entries as _file_path_entries,
    merge_workflow_contexts as _merge_context,
    not_ready_result as _not_ready_result,
    resolve_workflow_session as _resolve_session,
    selected_store as _selected_store,
    workflow_context as _context,
    workflow_result as _result_with_details,
)


WorkflowEventWriter = Callable[[dict[str, Any]], None]


def run_confirm_own_carrier_workflow(
    *,
    session: WorkflowBrowserSession | None = None,
    runtime: Any = None,
    payload: dict[str, Any],
    event_writer: WorkflowEventWriter,
    probe_ready_fn: Callable[..., dict[str, Any]] = probe_own_carrier_ready,
    confirm_fn: Callable[..., dict[str, Any]] = confirm_own_carrier_shipment,
) -> dict[str, Any]:
    _ = event_writer
    try:
        workflow_session = _resolve_session(session=session, runtime=runtime)
    except Exception as exc:
        return _result_with_details(
            params_ready=True,
            finished=False,
            exception=_exception_text(exc),
            file_path=_file_path_entries(
                ("shipment_summary_excel", str(getattr(exc, "shipment_summary_excel_path", "") or "").strip()),
            ),
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
        ready_payload = dict(probe_ready_fn(workflow_session, timeout_seconds=min(timeout_sec, 10)) or {})
        if not bool(ready_payload.get("ready")):
            return _not_ready_result(
                context=workflow_context,
                exception="当前页面未进入自己的承运人流程",
            )

        try:
            confirmed_payload = dict(
                confirm_fn(
                    workflow_session,
                    transport_mode=transport_mode,
                    consignment_no=consignment_no,
                    timeout_seconds=timeout_sec,
                )
                or {}
            )
        except Exception as exc:
            return _result_with_details(
                params_ready=True,
                finished=False,
                exception=_exception_text(exc),
                file_path=_file_path_entries(
                    ("shipment_summary_excel", str(getattr(exc, "shipment_summary_excel_path", "") or "").strip()),
                ),
                context=workflow_context,
            )

        return _result_with_details(
            params_ready=True,
            finished=True,
            notice=str(confirmed_payload.get("notice") or "").strip(),
            file_path=_file_path_entries(
                ("shipment_summary_excel", str(confirmed_payload.get("shipment_summary_excel_path") or "").strip()),
            ),
            context=workflow_context,
        )


__all__ = ["run_confirm_own_carrier_workflow"]
