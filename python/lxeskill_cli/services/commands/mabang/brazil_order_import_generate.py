from __future__ import annotations

from pathlib import Path
from typing import Any

from services.mabang.brazil_order_import.workflow import run as generate
from shared.filesystem import display_path


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    allowed = {"input_xlsx", "shipping_column"}
    if set(arguments) - allowed or "input_xlsx" not in arguments:
        return {
            "success": False,
            "status": "failed",
            "error": {"code": "invalid_arguments", "message": "仅接受必填 input_xlsx 和可选 shipping_column"},
        }
    input_xlsx = arguments["input_xlsx"]
    if not isinstance(input_xlsx, str) or not input_xlsx.strip():
        return {
            "success": False,
            "status": "failed",
            "error": {"code": "invalid_arguments", "message": "input_xlsx 必须是非空文件路径"},
        }
    shipping_column = arguments.get("shipping_column")
    if shipping_column is not None and (not isinstance(shipping_column, str) or not shipping_column.strip()):
        return {
            "success": False,
            "status": "failed",
            "error": {"code": "invalid_arguments", "message": "shipping_column 必须是 AT:BD 中的列名"},
        }
    try:
        result = generate(input_xlsx=input_xlsx, shipping_column=shipping_column)
    except Exception as exc:  # noqa: BLE001 — return the observed validation or IO error
        return {
            "success": False,
            "status": "failed",
            "error": {"code": str(getattr(exc, "code", "generation_failed")), "message": str(exc) or repr(exc)},
        }
    output = Path(result["output_xlsx"]).resolve(strict=True)
    return {
        "success": True,
        "status": "completed",
        "output_xlsx": str(display_path(output)),
        "order_id": result["order_id"],
        "sku_count": result["sku_count"],
        "quantity_value_count": result["quantity_value_count"],
        "shipping_column": result["shipping_column"],
        "shipping_header": result["shipping_header"],
        "shipping_date": result["shipping_date"],
        "validation": {"status": "passed", "checks": ["row_count", "sku_order", "quantity_values", "empty_quantities", "order_ids", "template_structure", "template_defaults"]},
    }
