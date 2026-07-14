from __future__ import annotations

import argparse
import asyncio
from typing import Any

from services.agent_cli._shared.json_cli import (
    JsonArgumentParser,
    configure_utf8_stdio,
    exception_text as _exception_text,
    write_json as _write_json,
)
from services.mabang.amazon.fba.store_msku import download_store_msku_excel
from shared.infra.net import close_all_network_clients
from shared.logging import setup_logging


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.download_store_msku_excel"
    )
    parser.add_argument("--store-id", default="")
    parser.add_argument("--id-type", default="")
    parser.add_argument("--store-name", default="")
    return parser


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    result = await download_store_msku_excel(
        str(getattr(args, "store_id", "") or "").strip(),
        str(getattr(args, "id_type", "") or "").strip(),
        store_name=str(getattr(args, "store_name", "") or "").strip(),
    )
    return result.to_payload()


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    setup_logging()
    store_name = ""
    store_id = ""
    id_type = ""
    try:
        args = build_parser().parse_args(argv)
        store_name = str(getattr(args, "store_name", "") or "").strip()
        store_id = str(getattr(args, "store_id", "") or "").strip()
        id_type = str(getattr(args, "id_type", "") or "").strip()
        payload = asyncio.run(_run_async(args))
    except Exception as exc:
        payload = {
            "success": False,
            "store_name": store_name,
            "store_id": store_id,
            "id_type": id_type,
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
