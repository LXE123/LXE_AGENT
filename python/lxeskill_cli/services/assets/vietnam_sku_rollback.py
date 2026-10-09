"""Internal fixed-slot Desktop command for rolling back a Vietnam SKU map."""

from __future__ import annotations

import os
from typing import Any

from services.vietnam_replenishment.sku_map_store import (
    REVISION_RE,
    SkuMapStoreError,
    rollback_sku_map,
)
from services.yacang.errors import safe_remote_detail


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    if set(arguments) != {"expected_revision"}:
        return {"success": False, "error": {"code": "invalid_arguments", "message": "只接受 expected_revision"}}
    revision = arguments["expected_revision"]
    if not isinstance(revision, str) or not REVISION_RE.fullmatch(revision):
        return {
            "success": False,
            "error": {"code": "invalid_arguments", "message": "expected_revision 必须是 32 位十六进制值"},
        }
    try:
        result = rollback_sku_map(revision)
    except Exception as exc:  # noqa: BLE001 - CLI reports the observed bounded failure
        secrets = tuple(os.getenv(name, "") for name in ("LXE_YACANG_MOBILE", "LXE_YACANG_PASSWORD"))
        detail = safe_remote_detail(f"{type(exc).__name__}: {exc}", secrets=secrets, limit=2000)
        code = "sku_map_store_error" if isinstance(exc, SkuMapStoreError) else type(exc).__name__
        return {"success": False, "error": {"code": code, "message": detail}}
    return {"success": True, "status": result.status, "manifest_revision": result.manifest_revision}


__all__ = ["run"]
