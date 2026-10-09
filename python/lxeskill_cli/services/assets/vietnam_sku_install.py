"""Internal fixed-slot Desktop command for installing a Vietnam SKU map."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from services.vietnam_replenishment.sku_map_store import (
    REVISION_RE,
    SkuMapStoreError,
    install_sku_map,
)
from services.yacang.errors import safe_remote_detail


def _failure(code: str, message: str) -> dict[str, Any]:
    return {"success": False, "error": {"code": code, "message": message}}


def _detail(exc: BaseException) -> str:
    secrets = tuple(os.getenv(name, "") for name in ("LXE_YACANG_MOBILE", "LXE_YACANG_PASSWORD"))
    return safe_remote_detail(f"{type(exc).__name__}: {exc}", secrets=secrets, limit=2000)


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    if set(arguments) != {"source_path", "expected_revision"}:
        return _failure("invalid_arguments", "只接受 source_path 和 expected_revision")
    raw_path = arguments["source_path"]
    raw_revision = arguments["expected_revision"]
    if not isinstance(raw_path, str) or not raw_path or not Path(raw_path).is_absolute():
        return _failure("invalid_arguments", "source_path 必须是绝对文件路径")
    if not isinstance(raw_revision, str) or raw_revision and not REVISION_RE.fullmatch(raw_revision):
        return _failure("invalid_arguments", "expected_revision 必须为空或 32 位十六进制值")
    try:
        result = install_sku_map(Path(raw_path), raw_revision or None)
    except Exception as exc:  # noqa: BLE001 - CLI reports the observed bounded failure
        code = "sku_map_store_error" if isinstance(exc, SkuMapStoreError) else type(exc).__name__
        return _failure(code, _detail(exc))
    return {"success": True, "status": result.status, "manifest_revision": result.manifest_revision}


__all__ = ["run"]
