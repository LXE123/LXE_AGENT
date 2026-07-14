from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


__all__ = [
    "JsonArgumentParser",
    "configure_utf8_stdio",
    "exception_text",
    "write_json",
]
