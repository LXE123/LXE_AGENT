from __future__ import annotations

from typing import Any, Callable

from agent_runtime.tools.fba_shipment_tools import (
    fill_shipment_template_payload,
    prepare_upload_local_consignment_excel_payload,
)
from services.agent_cli.browser.amazon_common.region_switch import normalize_site_code, switch_region
from services.agent_cli.browser.amazon_common.send_to_amazon import (
    download_template,
    open_send_to_amazon_upload_mode,
    upload_filled_template,
)
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
_PREPARE_UPLOAD_DONE_NOTICE_SUFFIX = "请执行第二阶段CLI。"


def run_prepare_upload_workflow(
    *,
    session: WorkflowBrowserSession | None = None,
    runtime: Any = None,
    payload: dict[str, Any],
    event_writer: WorkflowEventWriter,
    prepare_consignment_fn: Callable[[str], dict[str, Any]] = prepare_upload_local_consignment_excel_payload,
    fill_template_fn: Callable[[str, str, str], dict[str, Any]] = fill_shipment_template_payload,
    switch_region_fn: Callable[..., dict[str, Any]] = switch_region,
    open_upload_mode_fn: Callable[..., dict[str, Any]] = open_send_to_amazon_upload_mode,
    download_template_fn: Callable[..., dict[str, Any]] = download_template,
    upload_template_fn: Callable[..., dict[str, Any]] = upload_filled_template,
) -> dict[str, Any]:
    _ = event_writer
    try:
        workflow_session = _resolve_session(session=session, runtime=runtime)
    except Exception as exc:
        return _result_with_details(
            params_ready=True,
            finished=False,
            exception=_exception_text(exc),
            file_path=_file_path_entries(),
            context=_context(
                site=str(payload.get("site") or "").strip(),
                consignment_no=str(payload.get("consignment_no") or "").strip(),
                transport_mode=str(payload.get("transport_mode") or "").strip(),
            ),
        )
    runtime_session_id = str(workflow_session.session_id or "").strip()
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

    consignment_excel_path = ""
    template_path = ""
    filled_template_path = ""

    with bind_event_writer(lambda _payload: None):
        selected_store = _selected_store(workflow_session)
        if not str(selected_store.get("store_id") or "").strip():
            return _not_ready_result(
                context=workflow_context,
                exception="当前没有明确选中的店铺",
            )

        try:
            switch_region_fn(workflow_session, target_site, timeout_seconds=timeout_sec)
            open_upload_mode_fn(workflow_session, timeout_seconds=timeout_sec)
            consignment_payload = prepare_consignment_fn(consignment_no)
            consignment_excel_path = str(consignment_payload.get("excel_path") or "").strip()
            if not consignment_excel_path:
                raise RuntimeError("托运单 Excel 准备完成后未返回 excel_path")
            template_download = download_template_fn(workflow_session, timeout_seconds=timeout_sec)
            template_path = str(template_download.get("template_path") or "").strip()
            if not template_path:
                raise RuntimeError("Amazon 模板下载完成后未返回 template_path")
            fill_payload = fill_template_fn(template_path, consignment_excel_path, target_site)
            filled_template_path = str(fill_payload.get("filled_template_path") or "").strip()
            if not filled_template_path:
                raise RuntimeError("Amazon 模板填写完成后未返回 filled_template_path")
            upload_payload = dict(upload_template_fn(workflow_session, filled_template_path, timeout_seconds=timeout_sec) or {})
        except Exception as exc:
            return _result_with_details(
                params_ready=True,
                finished=False,
                exception=_exception_text(exc),
                file_path=_file_path_entries(
                    ("consignment_excel", consignment_excel_path),
                    ("amazon_template", template_path),
                    ("filled_template", filled_template_path),
                ),
                context=workflow_context,
            )

        upload_notice = str(upload_payload.get("notice") or "").strip()
        if upload_notice:
            notice = f"第一阶段完成，{upload_notice}，{_PREPARE_UPLOAD_DONE_NOTICE_SUFFIX}"
        else:
            notice = f"第一阶段完成，{_PREPARE_UPLOAD_DONE_NOTICE_SUFFIX}"

        return _result_with_details(
            params_ready=True,
            finished=True,
            notice=notice,
            file_path=_file_path_entries(
                ("consignment_excel", consignment_excel_path),
                ("amazon_template", template_path),
                ("filled_template", filled_template_path),
            ),
            context=workflow_context,
        )


__all__ = ["WorkflowBrowserSession", "run_prepare_upload_workflow"]
