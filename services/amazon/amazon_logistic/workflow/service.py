"""FBA 物流应用服务入口。"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from ..input.validator import VALID_SHIPMENT_PATTERN, normalize_consignment_no, normalize_shipment_no
from .single_flow import run_single_shipment_workflow
from .support import ensure_schema_if_needed


async def run_fba_logistics_workflow(
    shipment_no: str | None = None,
    consignment_no: str | None = None,
    destination_address: str | None = None,
    progress_callback: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    """执行 FBA 物流工作流。"""
    explicit_shipment_no = normalize_shipment_no(shipment_no)
    if not explicit_shipment_no:
        raise ValueError("shipment_no 参数不能为空")
    if not VALID_SHIPMENT_PATTERN.match(explicit_shipment_no):
        raise ValueError(f"shipment_no 参数无效: {shipment_no}")

    explicit_consignment_no = normalize_consignment_no(consignment_no)
    if not explicit_consignment_no:
        raise ValueError("consignment_no 参数不能为空")

    explicit_destination_address = " ".join(str(destination_address or "").split()).strip()
    if not explicit_destination_address:
        raise ValueError("destination_address 参数不能为空")

    await ensure_schema_if_needed(force=False)

    return await run_single_shipment_workflow(
        shipment_no=explicit_shipment_no,
        consignment_no=explicit_consignment_no,
        destination_address=explicit_destination_address,
        progress_callback=progress_callback,
    )
