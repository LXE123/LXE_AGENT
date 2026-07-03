from __future__ import annotations

import argparse

from services.agent_cli._shared.json_cli import (
    JsonArgumentParser,
    configure_utf8_stdio,
    exception_text as _exception_text,
    write_json as _write_json,
)
from services.mabang.amazon.fba.amazon_fba_inventory import (
    build_amazon_fba_inventory_snapshot,
    normalize_store_name,
)


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.build_amazon_fba_inventory_snapshot"
    )
    parser.add_argument("--store-name", default="")
    parser.add_argument("--csv", default="")
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--msku-xlsx", default="")
    parser.add_argument("--msku-dir", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    store_name = ""
    try:
        args = build_parser().parse_args(argv)
        store_name = normalize_store_name(getattr(args, "store_name", ""))
        csv_path = str(getattr(args, "csv", "") or "").strip()
        if not csv_path:
            raise ValueError("csv 不能为空")
        output_dir = str(getattr(args, "output_dir", "") or "").strip() or None
        msku_xlsx = str(getattr(args, "msku_xlsx", "") or "").strip() or None
        msku_dir = str(getattr(args, "msku_dir", "") or "").strip() or None
        result = build_amazon_fba_inventory_snapshot(
            csv_path,
            store_name=store_name,
            output_dir=output_dir,
            msku_xlsx_path=msku_xlsx,
            msku_dir=msku_dir,
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
