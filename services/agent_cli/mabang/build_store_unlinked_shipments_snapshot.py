from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.amazon.fba.unlinked_shipments import (
    build_store_unlinked_shipments_snapshot,
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
        prog="python -m services.agent_cli.mabang.build_store_unlinked_shipments_snapshot"
    )
    parser.add_argument("--store-name", default="")
    parser.add_argument("--raw-file", action="append", default=[])
    parser.add_argument("--output-dir", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    store_name = ""
    try:
        args = build_parser().parse_args(argv)
        store_name = normalize_store_name(getattr(args, "store_name", ""))
        raw_files = [str(value or "").strip() for value in getattr(args, "raw_file", [])]
        raw_files = [value for value in raw_files if value]
        output_dir = str(getattr(args, "output_dir", "") or "").strip() or None
        result = build_store_unlinked_shipments_snapshot(
            raw_files,
            store_name=store_name,
            output_dir=output_dir,
        )
        payload = result.to_payload()
    except Exception as exc:
        payload = {
            "success": False,
            "store_name": store_name,
            "exception": _exception_text(exc),
        }

    _write_json(payload)
    return 0 if bool(payload.get("success")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
