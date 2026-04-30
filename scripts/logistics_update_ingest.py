from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from services.amazon.amazon_logistic.remote_client import create_import_job, get_import_job, upload_import_file
from shared.config import config
from shared.infra.net import close_all_network_clients


TERMINAL_SUCCESS_STATUS = "succeeded"
TERMINAL_FAILED_STATUS = "failed"
PENDING_STATUSES = {"queued", "running"}


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = JsonArgumentParser(
        description="Submit or query a logistics pricing import job through the logistics API."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--file-path",
        help="Path to a workbook named 公司名-线路-YYYY.MM.DD.xlsx on the logistics service machine.",
    )
    group.add_argument(
        "--job-id",
        help="Existing logistics import job id to query.",
    )
    return parser.parse_args(argv)


def _error_text(error: BaseException) -> str:
    text = str(error).strip()
    return text or error.__class__.__name__


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _status(payload: dict[str, Any]) -> str:
    return str(payload.get("status") or "").strip().lower()


def _job_id(payload: dict[str, Any], fallback: str = "") -> str:
    return str(payload.get("job_id") or fallback or "").strip()


def _job_error(payload: dict[str, Any]) -> str:
    for key in ("error", "message", "exception", "detail"):
        value = str(payload.get(key) or "").strip()
        if value:
            return value
    return ""


def _config_int(name: str, default: int) -> int:
    try:
        return int(getattr(config, name, default))
    except Exception:
        return default


def _normalize_job_payload(
    payload: dict[str, Any],
    *,
    file_path: str = "",
    fallback_job_id: str = "",
) -> dict[str, Any]:
    safe_payload = dict(payload or {})
    status = _status(safe_payload)
    job_id = _job_id(safe_payload, fallback_job_id)
    base: dict[str, Any] = {
        "ok": status != TERMINAL_FAILED_STATUS,
        "job_id": job_id,
        "status": status or "unknown",
    }
    if file_path:
        base["file_path"] = str(Path(file_path))

    if status == TERMINAL_SUCCESS_STATUS:
        base["ok"] = True
        base["result"] = safe_payload.get("result")
        return base
    if status == TERMINAL_FAILED_STATUS:
        base["ok"] = False
        base["error"] = _job_error(safe_payload) or "物流导入任务失败"
        return base
    if status in PENDING_STATUSES:
        base["ok"] = True
        result = safe_payload.get("result")
        if result is not None:
            base["result"] = result
        message = str(safe_payload.get("message") or "").strip()
        if message:
            base["message"] = message
        return base

    base["ok"] = False
    base["error"] = f"未知导入任务状态: {status or '<empty>'}"
    return base


async def _query_job(job_id: str) -> dict[str, Any]:
    payload = await get_import_job(job_id)
    return _normalize_job_payload(payload, fallback_job_id=job_id)


async def _submit_and_poll(file_path: str) -> dict[str, Any]:
    safe_file_path = str(file_path or "").strip()
    if not safe_file_path:
        raise ValueError("file_path 不能为空")
    is_local_file = Path(safe_file_path).is_file()

    if is_local_file:
        created = await upload_import_file(safe_file_path)
    else:
        created = await create_import_job(safe_file_path)
    created_status = _status(created)
    job_id = _job_id(created)
    if created_status in {TERMINAL_SUCCESS_STATUS, TERMINAL_FAILED_STATUS}:
        return _normalize_job_payload(created, file_path=safe_file_path)
    if created_status and created_status not in PENDING_STATUSES:
        return _normalize_job_payload(created, file_path=safe_file_path)

    interval_seconds = max(0, _config_int("LOGISTICS_IMPORT_POLL_INTERVAL_SECONDS", 10))
    max_polls = max(0, _config_int("LOGISTICS_IMPORT_MAX_POLLS", 6))
    last_payload = created

    for _ in range(max_polls):
        if interval_seconds > 0:
            await asyncio.sleep(interval_seconds)
        last_payload = await get_import_job(job_id)
        status = _status(last_payload)
        if status in {TERMINAL_SUCCESS_STATUS, TERMINAL_FAILED_STATUS}:
            return _normalize_job_payload(last_payload, file_path=safe_file_path, fallback_job_id=job_id)
        if status not in PENDING_STATUSES:
            return _normalize_job_payload(last_payload, file_path=safe_file_path, fallback_job_id=job_id)

    result = _normalize_job_payload(last_payload, file_path=safe_file_path, fallback_job_id=job_id)
    result["ok"] = True
    result["status"] = "running"
    result["message"] = "导入任务仍在后台执行"
    return result


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    file_path = str(getattr(args, "file_path", "") or "").strip()
    job_id = str(getattr(args, "job_id", "") or "").strip()
    if job_id:
        return await _query_job(job_id)
    return await _submit_and_poll(file_path)


def _exit_code(payload: dict[str, Any], *, exception: BaseException | None = None) -> int:
    if exception is not None:
        return 3
    if not bool(payload.get("ok")):
        return 3
    return 0


def main(argv: list[str] | None = None) -> int:
    safe_file_path = ""
    try:
        args = parse_args(argv)
        safe_file_path = str(getattr(args, "file_path", "") or "").strip()
        payload = asyncio.run(_run_async(args))
        exit_code = _exit_code(payload)
    except Exception as error:
        payload = {
            "ok": False,
            "file_path": str(Path(safe_file_path)) if safe_file_path else "",
            "error": _error_text(error),
            "error_type": error.__class__.__name__,
        }
        exit_code = _exit_code(payload, exception=error)
    finally:
        try:
            asyncio.run(close_all_network_clients())
        except Exception:
            pass

    _print_json(payload)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
