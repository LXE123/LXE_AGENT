from __future__ import annotations

from pathlib import Path
from typing import Any

from services.mabang.order_import.workflow import COUNTRIES, run as generate
from shared.filesystem import display_path


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    allowed = {"country", "input_xlsx", "shipping_column"}
    if set(arguments) - allowed or not {"country", "input_xlsx"}.issubset(arguments):
        return {
            "success": False,
            "status": "failed",
            "error": {"code": "invalid_arguments", "message": "必填 country、input_xlsx；可选 shipping_column"},
        }
    country = arguments["country"]
    if not isinstance(country, str) or country not in COUNTRIES:
        return {
            "success": False,
            "status": "failed",
            "error": {"code": "invalid_arguments", "message": f"country 必须为 {'、'.join(COUNTRIES)}"},
        }
    input_xlsx = arguments["input_xlsx"]
    if not isinstance(input_xlsx, str) or not input_xlsx.strip():
        return {
            "success": False,
            "status": "failed",
            "error": {"code": "invalid_arguments", "message": "input_xlsx 必须是非空文件路径"},
        }
    shipping_column = arguments.get("shipping_column")
    if shipping_column is not None:
        if country not in {"brazil", "vietnam"}:
            return {
                "success": False,
                "status": "failed",
                "error": {"code": "invalid_arguments", "message": "shipping_column 仅用于巴西或越南备货清单"},
            }
        if not isinstance(shipping_column, str) or not shipping_column.strip():
            return {
                "success": False,
                "status": "failed",
                "error": {"code": "invalid_arguments", "message": "shipping_column 必须是有效的表格列名"},
            }
    try:
        result = generate(country=country, input_xlsx=input_xlsx, shipping_column=shipping_column)
    except Exception as exc:  # noqa: BLE001 — return the observed validation or IO error
        return {
            "success": False,
            "status": "failed",
            "error": {"code": str(getattr(exc, "code", "generation_failed")), "message": str(exc) or repr(exc)},
        }

    artifacts = []
    for item in result["artifacts"]:
        output = Path(item["path"]).resolve(strict=True)
        artifacts.append({**item, "path": str(display_path(output))})
    return {
        "success": True,
        "status": "completed",
        "country": result["country"],
        "artifacts": artifacts,
        "sku_count": result["sku_count"],
        "order_ids": result["order_ids"],
        "validation": {
            "status": "passed",
            "checks": ["sku_count", "sku_order", "quantity_values", "order_ids", "template_structure", "template_defaults"],
        },
    }
