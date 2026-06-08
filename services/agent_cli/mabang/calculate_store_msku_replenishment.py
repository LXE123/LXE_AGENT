from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.amazon.fba.store_msku_replenishment import calculate_store_msku_replenishment


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
        prog="python -m services.agent_cli.mabang.calculate_store_msku_replenishment"
    )
    parser.add_argument("--store-name", default="")
    parser.add_argument("--template", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    store_name = ""
    try:
        args = build_parser().parse_args(argv)
        store_name = str(getattr(args, "store_name", "") or "").strip()
        template_name = str(getattr(args, "template", "") or "").strip()
        result = calculate_store_msku_replenishment(store_name, template_name=template_name or None)
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
