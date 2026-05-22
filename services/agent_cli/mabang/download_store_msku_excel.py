from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.amazon.fba.store_msku import download_store_msku_excel
from shared.infra.net import close_all_network_clients


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
