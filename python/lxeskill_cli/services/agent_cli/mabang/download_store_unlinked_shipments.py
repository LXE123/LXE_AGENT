from __future__ import annotations

import asyncio
from typing import Any

from shared.logging import get_logger, setup_logging
from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba.unlinked_shipments import (
    StoreUnlinkedShipmentDownloadResult,
    build_store_unlinked_shipments_snapshot,
    download_store_unlinked_shipments,
    normalize_store_name,
)

logger = get_logger(__name__)


def _raw_file_paths_from_download_result(result: StoreUnlinkedShipmentDownloadResult) -> list[str]:
    return [
        str(row.raw_file_path or "").strip()
        for row in result.status_results
        if int(row.total or 0) > 0 and str(row.raw_file_path or "").strip()
    ]


async def _download_with_snapshot(
    store_name: str,
    *,
    timeout_sec: float,
    poll_interval_sec: float,
    output_dir: str | None,
) -> dict[str, Any]:
    result = await download_store_unlinked_shipments(
        store_name,
        timeout_sec=timeout_sec,
        poll_interval_sec=poll_interval_sec,
        output_dir=output_dir,
    )
    payload = result.to_payload()
    raw_file_paths = _raw_file_paths_from_download_result(result)
    if not raw_file_paths:
        logger.info("[UnlinkedShipments] 本次没有可生成快照的原生文件，跳过 snapshot")
        payload["snapshot"] = None
        payload["snapshot_skipped_reason"] = "本次没有可生成快照的未关联货件原生文件"
        return payload

    try:
        logger.info("[UnlinkedShipments] 开始生成 snapshot: raw_file_count=%d", len(raw_file_paths))
        snapshot = build_store_unlinked_shipments_snapshot(raw_file_paths, store_name=result.store_name)
    except Exception as exc:
        logger.warning("[UnlinkedShipments] 生成 snapshot 失败: %s", _exception_text(exc))
        return {
            "success": False,
            "store_name": result.store_name,
            "exception": _exception_text(exc),
            "download_result": payload,
        }
    payload["snapshot"] = snapshot.to_payload()
    logger.info("[UnlinkedShipments] 生成 snapshot 完成: %s", snapshot.snapshot_xlsx_path)
    return payload


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    store_name = str(arguments.get("store_name") or "").strip()
    try:
        timeout_sec = arguments.get("timeout_sec")
        poll_interval_sec = arguments.get("poll_interval_sec")
        return asyncio.run(_download_with_snapshot(
            normalize_store_name(arguments.get("store_name") or ""),
            timeout_sec=float(180 if timeout_sec is None else timeout_sec),
            poll_interval_sec=float(10 if poll_interval_sec is None else poll_interval_sec),
            output_dir=str(arguments.get("output_dir") or "").strip() or None,
        ))
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "store_name": store_name,
            "exception": _exception_text(exc),
        }
