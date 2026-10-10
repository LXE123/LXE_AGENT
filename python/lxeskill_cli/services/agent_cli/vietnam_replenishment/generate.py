"""Expose the deterministic Vietnam recommendation workflow to lxeskill."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from services.vietnam_replenishment.workflow import generate_current_vietnam_recommendation
from services.vietnam_replenishment.validation_diagnostics import validation_diagnostic
from services.vietnam_replenishment.settings import config_json
from shared.filesystem import display_path
from services.agent_cli._shared.report_names import YACANG_REPORTS, public_reports


def _failure(code: str, message: str) -> dict[str, Any]:
    return {
        "success": False,
        "status": "failed",
        "error": {"code": code, "message": message},
    }


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """Calculate supplied reports with an optional map and saved parameters."""
    required = {"sales_file", "inventory_file", "products_file"}
    if set(arguments) - (required | {"sku_map_file"}):
        return _failure("invalid_arguments", "仅接受 sales_file、inventory_file、products_file 和可选 sku_map_file 文件路径")
    if required - set(arguments):
        return _failure("invalid_arguments", f"缺少必填报表路径: {', '.join(sorted(required - set(arguments)))}")
    for name, value in arguments.items():
        if not isinstance(value, str) or not value.strip():
            return _failure("invalid_arguments", f"{name} 必须是非空文件路径")

    try:
        result = generate_current_vietnam_recommendation(**{name.removesuffix("_file"): value for name, value in arguments.items()})
        output = Path(result.output_xlsx).resolve(strict=True)
        if not output.is_file() or output.suffix.lower() != ".xlsx" or output.stat().st_size == 0:
            raise ValueError(f"最终 XLSX 无效: {output}")
    except Exception as exc:  # noqa: BLE001 — report the observed, redacted failure
        detail = validation_diagnostic(exc)
        return _failure(str(getattr(exc, "code", type(exc).__name__)), detail)

    return {
        "success": True,
        "status": "completed",
        "warehouse": "VN8806",
        "sku_count": result.sku_count,
        "output_xlsx": str(display_path(output)),
        "config": config_json(result.config),
        "config_source": result.config_source,
        "sku_map_source": result.sku_map_source,
        "source_files": public_reports(list(result.source_files), YACANG_REPORTS),
        "validation": result.validation,
    }
