from __future__ import annotations

import argparse

from services.agent_cli._shared.json_cli import (
    JsonArgumentParser,
    configure_utf8_stdio,
    exception_text as _exception_text,
    write_json as _write_json,
)
from services.mabang.amazon.fba.store_msku_replenishment import calculate_store_msku_replenishment


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.calculate_store_msku_replenishment"
    )
    parser.add_argument("--store-name", default="")
    parser.add_argument("--template", default="")
    parser.add_argument("--unlinked-shipments-snapshot", default="")
    parser.add_argument("--amazon-restock-inventory-snapshot", default="")
    parser.add_argument("--amazon-fba-inventory-snapshot", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    store_name = ""
    try:
        args = build_parser().parse_args(argv)
        store_name = str(getattr(args, "store_name", "") or "").strip()
        template_name = str(getattr(args, "template", "") or "").strip()
        unlinked_snapshot = str(getattr(args, "unlinked_shipments_snapshot", "") or "").strip()
        amazon_restock_inventory_snapshot = str(getattr(args, "amazon_restock_inventory_snapshot", "") or "").strip()
        amazon_fba_inventory_snapshot = str(getattr(args, "amazon_fba_inventory_snapshot", "") or "").strip()
        result = calculate_store_msku_replenishment(
            store_name,
            template_name=template_name or None,
            unlinked_shipments_snapshot_path=unlinked_snapshot or None,
            amazon_restock_inventory_snapshot_path=amazon_restock_inventory_snapshot or None,
            amazon_fba_inventory_snapshot_path=amazon_fba_inventory_snapshot or None,
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
