"""FBA 物流单票工作流。"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from ..artifacts.renderer import build_single_channel_pricing_markdown
from ..artifacts.store import save_artifacts
from ..pricing_engine import build_channel_price_snapshot, evaluate_request
from ..sources.consignment_excel import load_pricing_boxes_from_local_excel
from ..transport.selector import resolve_transport_selection
from .support import (
    build_request_from_runtime_inputs,
    load_candidate_rows_for_transport_selection,
    load_surcharge_rules_for_rows,
    resolve_test_case,
)


async def compute_single_shipment_pricing(
    shipment_no: str,
    consignment_no: str,
    destination_address: str,
    test_case_key: str | None = None,
    progress_callback: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """执行单票 FBA 物流计算，返回内存结果，不落盘。"""
    _, resolved_boxes_payload = load_pricing_boxes_from_local_excel(consignment_no)
    if len(resolved_boxes_payload) != 1:
        raise RuntimeError(
            f"装箱单 {consignment_no} 解析到 {len(resolved_boxes_payload)} 个箱子；"
            "单票模式只接受单箱装箱单，多箱请使用 TSV 多票模式"
        )
    return await compute_single_shipment_pricing_with_boxes(
        shipment_no=shipment_no,
        consignment_no=consignment_no,
        destination_address=destination_address,
        boxes_payload=resolved_boxes_payload,
        test_case_key=test_case_key,
        progress_callback=progress_callback,
    )


async def compute_single_shipment_pricing_with_boxes(
    *,
    shipment_no: str,
    consignment_no: str,
    destination_address: str,
    boxes_payload: list[dict[str, str]] | None,
    test_case_key: str | None = None,
    progress_callback: Callable[[str], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """执行单票 FBA 物流计算，可复用预解析箱规。"""
    _, default_payload = resolve_test_case(test_case_key)
    transport_selection = resolve_transport_selection(
        None,
        default_transport_mode=str(default_payload.get("transport_mode") or "air"),
    )

    resolved_boxes_payload = list(boxes_payload or [])
    if not resolved_boxes_payload:
        if progress_callback is not None:
            await progress_callback("正在读取装箱数据...")
        _, resolved_boxes_payload = load_pricing_boxes_from_local_excel(consignment_no)

    request = build_request_from_runtime_inputs(
        default_payload=default_payload,
        destination_address=destination_address,
        boxes_payload=resolved_boxes_payload,
        transport_mode=transport_selection.base_transport_mode,
    )

    if progress_callback is not None:
        await progress_callback("正在加载渠道和报价数据...")
    rows, transport_selection = await load_candidate_rows_for_transport_selection(transport_selection)
    if not rows:
        raise RuntimeError(
            "No active channels/tiers found for this transport mode. "
            "Please initialize and import pricing data first."
        )

    if progress_callback is not None:
        await progress_callback("正在计算渠道报价...")
    surcharge_rules_by_channel = await load_surcharge_rules_for_rows(rows, enabled=True)
    _ = evaluate_request(
        request,
        rows=rows,
        surcharge_rules_by_channel=surcharge_rules_by_channel,
    )

    pricing_snapshots = build_channel_price_snapshot(
        request,
        rows=rows,
        surcharge_rules_by_channel=surcharge_rules_by_channel,
        limit=50,
    )
    return {
        "shipment_no": shipment_no,
        "consignment_no": consignment_no,
        "destination_address": destination_address,
        "pricing_snapshots": pricing_snapshots,
    }


async def run_single_shipment_workflow(
    shipment_no: str,
    consignment_no: str,
    destination_address: str,
    test_case_key: str | None = None,
    progress_callback: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    """执行单票 FBA 物流渠道推荐。"""
    result = await compute_single_shipment_pricing(
        shipment_no=shipment_no,
        consignment_no=consignment_no,
        destination_address=destination_address,
        test_case_key=test_case_key,
        progress_callback=progress_callback,
    )
    pricing_details_markdown = build_single_channel_pricing_markdown(
        list(result.get("pricing_snapshots") or []),
        shipment_no=shipment_no,
        consignment_no=consignment_no,
        destination_address=destination_address,
        limit=50,
    )
    return save_artifacts(
        pricing_details_markdown,
        f"{shipment_no}_{consignment_no}",
        "channel_pricing",
    )
