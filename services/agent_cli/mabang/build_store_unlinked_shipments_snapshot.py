from __future__ import annotations

import argparse

from services.agent_cli._shared.json_cli import (
    JsonArgumentParser,
    configure_utf8_stdio,
    exception_text as _exception_text,
    write_json as _write_json,
)
from services.mabang.amazon.fba.unlinked_shipments import (
    build_store_unlinked_shipments_snapshot,
    normalize_store_name,
)


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
