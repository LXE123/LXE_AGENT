"""Business workflow that routes a Brazil overseas warehouse request to one export."""

from __future__ import annotations

from dataclasses import dataclass
from typing import NoReturn

from services.mabang.errors import MabangBusinessError

from .allocation import export_brazil_overseas_allocation
from .contracts import (
    BRAZIL_OVERSEAS_WAREHOUSE_ID,
    BRAZIL_OVERSEAS_WAREHOUSE_LABEL,
    INVENTORY_SALES_SOURCE_NOTE,
    BrazilExportKind,
)
from .intent import BrazilIntentClarification, validate_brazil_export_parameters
from .inventory import export_brazil_overseas_inventory_sales_snapshot


ALLOCATION_SOURCE_NOTE = "马帮分仓调拨原始导出"


class BrazilOverseasRequestClarificationError(MabangBusinessError):
    def __init__(self, clarification: BrazilIntentClarification) -> None:
        super().__init__(clarification.message)
        self.code = clarification.code


@dataclass(frozen=True)
class BrazilOverseasWorkflowResult:
    kind: BrazilExportKind
    xlsx_path: str = ""
    xlsx_paths: tuple[str, ...] = ()
    warehouse_id: str = BRAZIL_OVERSEAS_WAREHOUSE_ID
    warehouse_label: str = BRAZIL_OVERSEAS_WAREHOUSE_LABEL
    source_data_note: str = ""

    def to_payload(self) -> dict[str, str | bool | list[str]]:
        payload: dict[str, str | bool | list[str]] = {
            "success": True,
            "kind": self.kind.value,
            "warehouse_id": self.warehouse_id,
            "warehouse_label": self.warehouse_label,
            "source_data_note": self.source_data_note,
        }
        if self.xlsx_path:
            payload["xlsx_path"] = self.xlsx_path
        if self.xlsx_paths:
            payload["xlsx_paths"] = list(self.xlsx_paths)
        return payload


def _raise_clarification(clarification: BrazilIntentClarification) -> NoReturn:
    raise BrazilOverseasRequestClarificationError(clarification)


async def export_brazil_overseas(*, warehouse: str, export_kind: str) -> BrazilOverseasWorkflowResult:
    """Run exactly one approved export from model-resolved structured parameters."""
    resolved = validate_brazil_export_parameters(warehouse=warehouse, export_kind=export_kind)
    if isinstance(resolved, BrazilIntentClarification):
        _raise_clarification(resolved)

    if resolved.kind is BrazilExportKind.INVENTORY_SALES_SNAPSHOT:
        result = await export_brazil_overseas_inventory_sales_snapshot()
        return BrazilOverseasWorkflowResult(
            kind=resolved.kind,
            xlsx_path=result.xlsx_path,
            source_data_note=INVENTORY_SALES_SOURCE_NOTE,
        )

    if resolved.kind is BrazilExportKind.ALLOCATION_BOTH:
        pending = await export_brazil_overseas_allocation(
            BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M
        )
        signed = await export_brazil_overseas_allocation(
            BrazilExportKind.ALLOCATION_SIGNED_BEFORE_3M
        )
        return BrazilOverseasWorkflowResult(
            kind=resolved.kind,
            xlsx_paths=(pending.xlsx_path, signed.xlsx_path),
            source_data_note=ALLOCATION_SOURCE_NOTE,
        )

    result = await export_brazil_overseas_allocation(resolved.kind)
    return BrazilOverseasWorkflowResult(
        kind=resolved.kind,
        xlsx_path=result.xlsx_path,
        source_data_note=ALLOCATION_SOURCE_NOTE,
    )


__all__ = [
    "BrazilOverseasRequestClarificationError",
    "BrazilOverseasWorkflowResult",
    "export_brazil_overseas",
]
