from __future__ import annotations
import json
import re
from urllib.parse import quote, quote_plus


class BrazilError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def diagnostic(value, secrets=(), limit=2000):
    text = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value)
    for secret in sorted(filter(None, secrets), key=len, reverse=True):
        for form in (secret, quote(secret, safe=''), quote_plus(secret), json.dumps(secret, ensure_ascii=False)[1:-1]):
            text = text.replace(form, '[REDACTED]')
    text = re.sub(r'https?://[^\s"\'<>]+', '[REDACTED_URL]', text)
    text = re.sub(r'''(?i)(["']?(?:[\w-]*token|authorization|cookie|set-cookie|password|memcacheKey|cMKey|signed|route)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)''', r'\1[REDACTED]', text)
    return text if len(text) <= limit else text[:limit] + ' … [truncated]'
