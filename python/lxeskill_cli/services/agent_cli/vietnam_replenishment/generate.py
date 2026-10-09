"""Expose the deterministic Vietnam recommendation workflow to lxeskill."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from services.vietnam_replenishment.workflow import generate_current_vietnam_recommendation
from services.yacang.errors import safe_remote_detail
from shared.filesystem import display_path


def _failure(code: str, message: str) -> dict[str, Any]:
    return {
        "success": False,
        "status": "failed",
        "error": {"code": code, "message": message},
    }


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """Run once, without accepting map paths or per-chat parameter overrides."""
    if arguments:
        return _failure("invalid_arguments", "越南备货命令不接受参数或文件路径")

    try:
        result = generate_current_vietnam_recommendation()
        output = Path(result.output_xlsx).resolve(strict=True)
        if not output.is_file() or output.suffix.lower() != ".xlsx" or output.stat().st_size == 0:
            raise ValueError(f"最终 XLSX 无效: {output}")
    except Exception as exc:  # noqa: BLE001 — report the observed, redacted failure
        secrets = tuple(
            os.getenv(name, "")
            for name in ("LXE_YACANG_MOBILE", "LXE_YACANG_PASSWORD")
        )
        detail = safe_remote_detail(f"{type(exc).__name__}: {exc}", secrets=secrets)
        return _failure(str(getattr(exc, "code", type(exc).__name__)), detail)

    return {
        "success": True,
        "status": "completed",
        "warehouse": "VN8806",
        "sku_count": result.sku_count,
        "output_xlsx": str(display_path(output)),
        "config": {
            "weight_30d": str(result.config.weight_30d),
            "weight_15d": str(result.config.weight_15d),
            "weight_7d": str(result.config.weight_7d),
            "exchange_rate": str(result.config.exchange_rate),
        },
        "config_source": result.config_source,
    }
