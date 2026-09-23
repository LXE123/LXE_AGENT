from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote, quote_plus


class YacangError(RuntimeError):
    def __init__(self, stage: str, message: str, *, code: str = "YACANG_ERROR", scope: str = "local"):
        super().__init__(f"雅仓 {stage}: {message}")
        self.code, self.scope = code, scope


def safe_remote_detail(value: Any, *, secrets: tuple[str, ...] = (), limit: int = 2000) -> str:
    # Redact the complete value before truncation, including unlabelled reflected secrets.
    text = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
    for secret in sorted(filter(None, secrets), key=len, reverse=True):
        for form in (secret, quote(secret, safe=""), quote_plus(secret), json.dumps(secret, ensure_ascii=False)[1:-1]):
            text = text.replace(form, "[REDACTED]")
    text = re.sub(r'https?://[^\s\"\'<>]+', '[REDACTED_URL]', text)
    text = re.sub(r'''(?i)(["']?(?:[\w-]*token|authorization|cookie|set-cookie|password|mobile|verify_code|key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)''', r'\1[REDACTED]', text)
    text = re.sub(r'data:image/[^\s"\']+', '[REDACTED_IMAGE]', text)
    return text if len(text) <= limit else text[:limit] + " … [truncated]"
