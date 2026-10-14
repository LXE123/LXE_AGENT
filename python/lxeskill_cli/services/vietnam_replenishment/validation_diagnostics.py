"""Show the observed validation error with existing redaction and bounds."""

from __future__ import annotations

import os

from services.yacang.errors import safe_remote_detail


def validation_diagnostic(exc: BaseException) -> str:
    secrets = tuple(os.environ.get(name, "") for name in ("LXE_YACANG_MOBILE", "LXE_YACANG_PASSWORD"))
    return safe_remote_detail(f"{type(exc).__name__}: {exc}", secrets=secrets)
