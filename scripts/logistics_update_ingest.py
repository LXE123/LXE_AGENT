from __future__ import annotations

import argparse
import contextlib
import io
import json
import sys
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(r"D:\rpa\PRD\amazon\20260212 - AMAZON_logistic\logistics_excel")


class BridgeEnvironmentError(RuntimeError):
    """Raised when the bridge cannot run because the local environment is incomplete."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run logistics workbook ingest through a local bridge that emits JSON only."
    )
    parser.add_argument(
        "--file-path",
        required=True,
        help="Path to a workbook named 公司名-线路-YYYY.MM.DD.xlsx",
    )
    return parser.parse_args()


def _error_text(error: BaseException) -> str:
    text = str(error).strip()
    return text or error.__class__.__name__


def _is_environment_error(error: BaseException) -> bool:
    if isinstance(error, BridgeEnvironmentError):
        return True
    if isinstance(error, (ModuleNotFoundError, ImportError)):
        return True
    if isinstance(error, SystemExit):
        return True
    if isinstance(error, RuntimeError):
        text = _error_text(error).lower()
        return any(
            marker in text
            for marker in (
                "missing dsn",
                "missing llm api key",
                "project root not found",
                "required dependency",
            )
        )
    return False


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _load_ingest_dependencies() -> tuple[Any, Any, Any]:
    if not PROJECT_ROOT.is_dir():
        raise BridgeEnvironmentError(f"Project root not found: {PROJECT_ROOT}")

    sys.path.insert(0, str(PROJECT_ROOT))
    try:
        from logistics_ingest.app.ingest_service import ingest_file
        from logistics_ingest.shared.settings import default_out_dir, load_settings
    except Exception as error:
        raise BridgeEnvironmentError(_error_text(error)) from error
    return ingest_file, load_settings, default_out_dir


def ingest_one(file_path: str | Path) -> dict[str, Any]:
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
        ingest_file, load_settings, default_out_dir = _load_ingest_dependencies()
        settings = load_settings()
        if not str(settings.pg_dsn or "").strip():
            raise BridgeEnvironmentError("Missing DSN. Provide --dsn or set PG_DSN.")
        return ingest_file(
            file_path=Path(file_path),
            dsn=settings.pg_dsn,
            output_root=default_out_dir() / "update_runs",
            data_only=False,
            bounds_mode="effective",
            truncate=True,
            llm_divisor_check=True,
            llm_api_key=settings.deepseek_api_key,
            llm_model="deepseek-chat",
            llm_divisor_confidence=0.8,
            min_channels=1,
            min_tiers=1,
            max_parser_flags=-1,
            require_channels_for_expected=True,
        )


def main() -> int:
    args = parse_args()
    safe_file_path = str(Path(args.file_path))

    try:
        result = ingest_one(args.file_path)
    except BaseException as error:
        payload = {
            "ok": False,
            "file_path": safe_file_path,
            "error": _error_text(error),
            "error_type": error.__class__.__name__,
        }
        _print_json(payload)
        return 2 if _is_environment_error(error) else 3

    _print_json(
        {
            "ok": True,
            "file_path": safe_file_path,
            "result": result,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
