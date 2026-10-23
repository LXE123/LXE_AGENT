"""Private Kit process launch used by the bounded business adapter."""

from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess


def configured_file(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is not configured; prepare the LXE Office runtime and restart the host")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{name} must be an absolute path: {value}")
    if not path.is_file():
        raise FileNotFoundError(f"{name} is not a file: {value}")
    return str(path)


def run_kit(arguments: list[str]) -> int:
    process = subprocess.Popen([configured_file("LXE_OFFICE_NODE"), configured_file("LXE_OFFICE_CLI"), *arguments])
    previous = {}

    def forward(signum: int, _frame: object) -> None:
        if process.poll() is None:
            process.send_signal(signum)

    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.signal(signum, forward)
        code = process.wait()
        return 128 - code if code < 0 else code
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)

