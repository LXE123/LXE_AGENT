from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from shared.infra.net import close_all_network_clients
from shared.logging import logger
from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.amazon.fba.unlinked_shipments import (
    StoreUnlinkedShipmentDownloadResult,
    build_store_unlinked_shipments_snapshot,
    download_store_unlinked_shipments,
    normalize_store_name,
)


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def _write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.download_store_unlinked_shipments"
    )
    parser.add_argument("--store-name", default="")
    parser.add_argument("--timeout-sec", type=float, default=180)
    parser.add_argument("--poll-interval-sec", type=float, default=10)
    parser.add_argument("--output-dir", default="")
    return parser


def _raw_file_paths_from_download_result(result: StoreUnlinkedShipmentDownloadResult) -> list[str]:
    return [
        str(row.raw_file_path or "").strip()
        for row in result.status_results
        if int(row.total or 0) > 0 and str(row.raw_file_path or "").strip()
    ]


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    store_name = normalize_store_name(getattr(args, "store_name", ""))
    timeout_sec = getattr(args, "timeout_sec", 180)
    poll_interval_sec = getattr(args, "poll_interval_sec", 10)
    output_dir = str(getattr(args, "output_dir", "") or "").strip() or None
    result = await download_store_unlinked_shipments(
        store_name,
        timeout_sec=float(180 if timeout_sec is None else timeout_sec),
        poll_interval_sec=float(10 if poll_interval_sec is None else poll_interval_sec),
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


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    store_name = ""
    try:
        args = build_parser().parse_args(argv)
        store_name = str(getattr(args, "store_name", "") or "").strip()
        payload = asyncio.run(_run_async(args))
    except Exception as exc:
        payload = {
            "success": False,
            "store_name": store_name,
            "exception": _exception_text(exc),
        }
    finally:
        try:
            asyncio.run(close_all_network_clients())
        except Exception:
            pass

    _write_json(payload)
    return 0 if bool(payload.get("success")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
