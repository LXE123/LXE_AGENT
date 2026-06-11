from __future__ import annotations

import argparse
import json
import sys

from shared.infra.net import bootstrap_network_policy
from shared.logging import logger


def _configure_utf8_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    _configure_utf8_stdio()
    bootstrap_network_policy(label="browser_auth_service", emit=logger.info)
    from .service import ensure_auth

    parser = argparse.ArgumentParser(prog="browser_auth_service")
    subparsers = parser.add_subparsers(dest="command", required=True)

    ensure_parser = subparsers.add_parser("ensure")
    ensure_parser.add_argument("--scope", required=True, choices=["fba", "erp", "private_amz"])
    ensure_parser.add_argument("--account", default="")
    ensure_parser.add_argument("--require-wms-cookie-header", action="store_true")

    args = parser.parse_args()

    try:
        if args.command != "ensure":
            raise ValueError(f"未知命令: {args.command}")

        result = ensure_auth(
            scope=args.scope,
            account=args.account,
            require_wms_cookie_header=bool(args.require_wms_cookie_header),
        )
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:
        json.dump({"success": False, "message": str(exc)}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
