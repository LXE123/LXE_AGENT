from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.amazon.fba import download_fba_delivery_csv
from services.mabang.amazon.fba.batch_delivery import normalize_delivery_no
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


def _require_delivery_no(value: Any) -> str:
    delivery_no = normalize_delivery_no(value)
    if not delivery_no:
        raise ValueError("delivery_no 不能为空")
    if not delivery_no.startswith("SP"):
        raise ValueError(f"delivery_no 格式无效: {delivery_no}")
    return delivery_no


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.download_fba_delivery_csv"
    )
    parser.add_argument("--delivery-no", default="")
    parser.add_argument("--timeout-sec", type=float, default=180)
    parser.add_argument("--poll-interval-sec", type=float, default=3)
    return parser


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    delivery_no = _require_delivery_no(getattr(args, "delivery_no", ""))
    timeout_sec = getattr(args, "timeout_sec", 180)
    poll_interval_sec = getattr(args, "poll_interval_sec", 3)
    result = await download_fba_delivery_csv(
        delivery_no,
        timeout_sec=float(180 if timeout_sec is None else timeout_sec),
        poll_interval_sec=float(3 if poll_interval_sec is None else poll_interval_sec),
    )
    return result.to_payload()


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    delivery_no = ""
    try:
        args = build_parser().parse_args(argv)
        delivery_no = normalize_delivery_no(getattr(args, "delivery_no", ""))
        payload = asyncio.run(_run_async(args))
    except Exception as exc:
        payload = {
            "success": False,
            "delivery_no": delivery_no,
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
