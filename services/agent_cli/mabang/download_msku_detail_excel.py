from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.amazon.fba.msku_detail import download_msku_detail_excel, normalize_ship_no
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
        prog="python -m services.agent_cli.mabang.download_msku_detail_excel"
    )
    parser.add_argument("--ship-no", default="")
    parser.add_argument("--delivery-no", default="")
    return parser


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    ship_no = normalize_ship_no(getattr(args, "ship_no", ""))
    delivery_no = normalize_ship_no(getattr(args, "delivery_no", ""))
    if ship_no and delivery_no and ship_no != delivery_no:
        raise ValueError(f"ship_no 和 delivery_no 不一致: ship_no={ship_no}, delivery_no={delivery_no}")
    ship_no = delivery_no or ship_no
    result = await download_msku_detail_excel(ship_no)
    return result.to_payload()


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    ship_no = ""
    try:
        args = build_parser().parse_args(argv)
        ship_no = normalize_ship_no(getattr(args, "delivery_no", "")) or normalize_ship_no(
            getattr(args, "ship_no", "")
        )
        payload = asyncio.run(_run_async(args))
    except Exception as exc:
        payload = {
            "success": False,
            "ship_no": ship_no,
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
