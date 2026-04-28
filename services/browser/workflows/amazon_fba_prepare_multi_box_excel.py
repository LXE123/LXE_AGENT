from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from agent_runtime.tools.fba_shipment_tools import prepare_local_consignment_excel_payload
from services.agent_cli.browser.amazon_fba.step2_excel_fill import fill_multi_box_step2_template
from services.agent_cli.browser.amazon_common.region_switch import normalize_site_code
from services.agent_cli.browser.amazon_common.send_to_amazon_multi_box import (
    confirm_and_continue_to_own_carrier,
    download_generated_multi_box_template,
    generate_multi_box_excel,
    probe_multi_box_ready,
    upload_filled_multi_box_excel,
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
_PREPARE_MULTI_BOX_DONE_NOTICE = "第二阶段完成，已可选择自己的承运人，请执行第三阶段CLI。"


def _weight_capped_notice(items: list[dict[str, Any]]) -> str:
    if not items:
        return ""
    box_numbers = [
        str(int(item.get("box_no") or 0))
        for item in items
        if int(item.get("box_no") or 0) > 0
    ]
    if not box_numbers:
        return "有包装箱重量超过 40 lb，已自动按 40 lb 填写。"
    return (
        f"有 {len(box_numbers)} 个包装箱重量超过 40 lb，"
        f"已自动按 40 lb 填写（箱号: {', '.join(box_numbers)}）。"
    )


def extract_box_count_from_consignment_excel(excel_path: str | Path) -> int:
    try:
        import pandas as pd
    except Exception as exc:
        raise RuntimeError("缺少 pandas 依赖，无法读取托运单 Excel") from exc

    excel_file = Path(str(excel_path or "").strip()).expanduser()
    if not excel_file.is_absolute():
        excel_file = (Path.cwd() / excel_file).resolve()
    else:
        excel_file = excel_file.resolve()
    if not excel_file.is_file():
        raise RuntimeError(f"找不到托运单 Excel: {excel_file}")

    try:
        with pd.ExcelFile(excel_file) as xls:
            sheet_names = [str(name) for name in xls.sheet_names]
    except Exception as exc:
        raise RuntimeError(f"读取托运单 Excel 失败: {excel_file}, error={exc}") from exc

    if not sheet_names:
        raise RuntimeError(f"托运单 Excel 没有可用 sheet: {excel_file.name}")
    target_sheet = "FBA装箱任务" if "FBA装箱任务" in sheet_names else sheet_names[0]

    try:
        df = pd.read_excel(excel_file, sheet_name=target_sheet, header=None)
    except Exception as exc:
        raise RuntimeError(f"读取托运单 Excel sheet 失败: {excel_file.name}#{target_sheet}, error={exc}") from exc

    if df.empty or int(df.shape[1] or 0) <= 0:
        raise RuntimeError(f"托运单 Excel 第一列为空: {excel_file.name}")

    series = df.iloc[:, 0]
    values = []
    for item in list(series):
        text = str(item or "").strip()
        if not text or text.lower() == "nan":
            continue
        values.append(item)
    if not values:
        raise RuntimeError(f"托运单 Excel 第一列没有有效箱数: {excel_file.name}")

    raw_value = values[-1]
    try:
        numeric = float(raw_value)
    except Exception as exc:
        raise RuntimeError(f"托运单 Excel 第一列最后一行不是数字: {raw_value}") from exc
    rounded = round(numeric)
    if abs(numeric - rounded) > 1e-6:
        raise RuntimeError(f"托运单 Excel 箱数不是整数: {raw_value}")
    box_count = int(rounded)
    if box_count <= 0:
        raise RuntimeError(f"托运单 Excel 箱数必须大于 0: {raw_value}")
    return box_count


def run_prepare_multi_box_excel_workflow(
    *,
    session: WorkflowBrowserSession | None = None,
    runtime: Any = None,
    payload: dict[str, Any],
    event_writer: WorkflowEventWriter,
    prepare_consignment_fn: Callable[[str], dict[str, Any]] = prepare_local_consignment_excel_payload,
    box_count_reader: Callable[[str | Path], int] = extract_box_count_from_consignment_excel,
    probe_ready_fn: Callable[..., dict[str, Any]] = probe_multi_box_ready,
    generate_multi_box_fn: Callable[..., dict[str, Any]] = generate_multi_box_excel,
    download_step2_template_fn: Callable[..., dict[str, Any]] = download_generated_multi_box_template,
    fill_step2_template_fn: Callable[[str | Path, str | Path], dict[str, Any]] = fill_multi_box_step2_template,
    upload_step2_fn: Callable[..., dict[str, Any]] = upload_filled_multi_box_excel,
    confirm_continue_fn: Callable[..., dict[str, Any]] = confirm_and_continue_to_own_carrier,
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
    step2_template_path = ""
    step2_filled_path = ""
    weight_capped_boxes: list[dict[str, Any]] = []

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
                exception="当前页面未进入多包装箱流程",
            )

        try:
            consignment_payload = prepare_consignment_fn(consignment_no)
            consignment_excel_path = str(consignment_payload.get("excel_path") or "").strip()
            if not consignment_excel_path:
                raise RuntimeError("托运单 Excel 准备完成后未返回 excel_path")
            box_count = int(box_count_reader(consignment_excel_path))
            _ = dict(
                generate_multi_box_fn(workflow_session, box_count=box_count, timeout_seconds=timeout_sec) or {}
            )
            template_payload = dict(download_step2_template_fn(workflow_session, timeout_seconds=timeout_sec) or {})
            step2_template_path = str(template_payload.get("template_path") or "").strip()
            if not step2_template_path:
                raise RuntimeError("step2 模板下载完成后未返回 template_path")
            filled_payload = dict(fill_step2_template_fn(consignment_excel_path, step2_template_path) or {})
            step2_filled_path = str(filled_payload.get("filled_template_path") or "").strip()
            if not step2_filled_path:
                raise RuntimeError("step2 模板填写完成后未返回 filled_template_path")
            weight_capped_boxes = list(filled_payload.get("weight_capped_boxes") or [])
            upload_payload = dict(upload_step2_fn(workflow_session, step2_filled_path, timeout_seconds=timeout_sec) or {})
        except Exception as exc:
            return _result_with_details(
                params_ready=True,
                finished=False,
                exception=_exception_text(exc),
                file_path=_file_path_entries(
                    ("consignment_excel", consignment_excel_path),
                    ("step2_template", step2_template_path),
                    ("step2_filled", step2_filled_path),
                ),
                context=workflow_context,
            )

        upload_status = str(upload_payload.get("status") or "").strip().lower()
        upload_notice = str(upload_payload.get("notice") or "").strip()
        file_path = _file_path_entries(
            ("consignment_excel", consignment_excel_path),
            ("step2_template", step2_template_path),
            ("step2_filled", step2_filled_path),
        )

        if upload_status == "error":
            return _result_with_details(
                params_ready=True,
                finished=True,
                notice=upload_notice,
                file_path=file_path,
                context=workflow_context,
            )

        warning_notice = ""
        if upload_status == "warning":
            warning_notice = upload_notice

        if upload_status not in {"success", "warning"}:
            return _result_with_details(
                params_ready=True,
                finished=False,
                exception=f"未知 step2 上传状态: {upload_status or 'empty'}",
                file_path=file_path,
                context=workflow_context,
            )

        try:
            _ = dict(confirm_continue_fn(workflow_session, timeout_seconds=30) or {})
        except Exception as exc:
            return _result_with_details(
                params_ready=True,
                finished=False,
                exception=_exception_text(exc),
                file_path=file_path,
                context=workflow_context,
            )

        capped_notice = _weight_capped_notice(weight_capped_boxes)
        done_notice = _PREPARE_MULTI_BOX_DONE_NOTICE
        if capped_notice:
            done_notice = f"{done_notice}{capped_notice}"

        return _result_with_details(
            params_ready=True,
            finished=True,
            notice=(
                f"{warning_notice}；{done_notice}"
                if warning_notice
                else done_notice
            ),
            file_path=file_path,
            context=workflow_context,
        )


__all__ = [
    "extract_box_count_from_consignment_excel",
    "run_prepare_multi_box_excel_workflow",
]
