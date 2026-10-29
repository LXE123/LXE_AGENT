"""Public report names, translated only at the CLI boundary."""

from typing import Any

YACANG_REPORTS = {
    "inventory-sales": "inventory-sales",
    "inventory": "inventory-current-snapshot",
    "products": "warehouse-products",
}
BRAZIL_REPORTS = {
    "inventory-sales": "inventory_sales_snapshot",
    "pending-transfers-within-3-months": "allocation_pending_default_3m",
    "received-transfers-before-3-months": "allocation_signed_before_3m",
}


def selected_reports(value: Any, names: dict[str, str]) -> list[str]:
    if not isinstance(value, list) or not value or any(
        not isinstance(item, str) or item not in names for item in value
    ):
        raise ValueError(f"--report requires one or more of: {', '.join(names)}")
    return [names[item] for item in dict.fromkeys(value)]


def public_reports(value: Any, names: dict[str, str]) -> Any:
    """Translate report fields without rewriting diagnostics, filters or IDs."""
    reverse = {internal: public for public, internal in names.items()}
    if isinstance(value, list):
        return [public_reports(item, names) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    for key, item in value.items():
        if key == "report" and isinstance(item, str):
            result[key] = reverse.get(item, item)
        elif key == "reports" and isinstance(item, list):
            result[key] = [reverse.get(report, report) if isinstance(report, str) else report for report in item]
        elif key in {"error", "context", "filters", "diagnostic"}:
            result[key] = item
        else:
            result[key] = public_reports(item, names)
    return result
