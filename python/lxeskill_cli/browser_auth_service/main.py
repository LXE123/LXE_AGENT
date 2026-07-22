from __future__ import annotations

import argparse
import json
import sys

from shared.infra.net import bootstrap_network_policy
from shared.logging import get_logger, setup_logging

logger = get_logger(__name__)


def _configure_utf8_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    _configure_utf8_stdio()
    setup_logging()
    bootstrap_network_policy(label="browser_auth_service", emit=logger.info)
    from .service import BrowserAuthRefreshError, refresh_auth

    parser = argparse.ArgumentParser(prog="browser_auth_service")
    subparsers = parser.add_subparsers(dest="command", required=True)

    refresh_parser = subparsers.add_parser("refresh")
    refresh_parser.add_argument("--account", default="")

    args = parser.parse_args()

    try:
        if args.command != "refresh":
            raise ValueError(f"未知命令: {args.command}")

        result = refresh_auth(account=args.account)
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    except BrowserAuthRefreshError as exc:
        json.dump(exc.to_payload(), sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return 1
    except Exception as exc:
        json.dump(
            {
                "success": False,
                "stage": "browser",
                "current_url": "",
                "exception_type": type(exc).__name__,
                "message": str(exc),
            },
            sys.stdout,
            ensure_ascii=False,
        )
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
