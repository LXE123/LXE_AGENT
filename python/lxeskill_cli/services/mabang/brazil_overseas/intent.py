"""Validation for model-resolved Brazil export parameters."""

from dataclasses import dataclass

from .contracts import BrazilExportKind, BrazilExportPlan


@dataclass(frozen=True)
class BrazilIntentClarification:
    code: str
    message: str


def validate_brazil_export_parameters(
    *, warehouse: str, export_kind: str,
) -> BrazilExportPlan | BrazilIntentClarification:
    """Validate canonical parameters; prose translation belongs to the selected Skill, not a global Runtime filter."""
    normalized_warehouse = str(warehouse or "").strip().lower()
    if normalized_warehouse != "brazil_overseas":
        return BrazilIntentClarification(
            code="brazil_warehouse_required",
            message="warehouse 必须明确指定为 brazil_overseas（巴西海外仓）。",
        )

    try:
        kind = BrazilExportKind(str(export_kind or "").strip())
    except ValueError:
        return BrazilIntentClarification(
            code="brazil_export_kind_required",
            message=(
                "export_kind 必须是 inventory_sales_snapshot、allocation_both、"
                "allocation_signed_before_3m 或 allocation_pending_default_3m。"
            ),
        )
    return BrazilExportPlan(kind=kind)


__all__ = ["BrazilIntentClarification", "validate_brazil_export_parameters"]
