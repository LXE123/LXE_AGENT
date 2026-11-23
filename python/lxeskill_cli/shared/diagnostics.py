"""对外诊断的脱敏、HTML 清理及显式截断，供业务与执行基础设施共用。"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from shared.infra.cloud_client import redact


def exception_text(exc: Exception) -> str:
    """Keep the actual exception and up to three explicit causes, before redaction."""
    parts = [f"{type(exc).__name__}: {exc}"]
    for _ in range(3):
        exc = exc.__cause__
        if exc is None:
            break
        parts.append(f"caused by {type(exc).__name__}: {exc}")
    return "; ".join(parts)


def _business_urls(value: Any, policy) -> Any:
    """Apply an explicit caller policy before general text redaction consumes queries."""
    if isinstance(value, dict):
        return {key: _business_urls(item, policy) for key, item in value.items()}
    if isinstance(value, list):
        return [_business_urls(item, policy) for item in value]
    return re.sub(r"https?://[^\s<>\"']+", lambda match: policy(match.group()), value) if isinstance(value, str) else value


def html_text(value: str) -> str:
    """Read text only; never render response HTML or execute its scripts."""
    soup = BeautifulSoup(value, "html.parser")
    for node in soup(["script", "style", "iframe", "template", "input"]):
        node.decompose()
    for node in soup.find_all("br"):
        node.replace_with("\n")
    return "\n".join(" ".join(line.split()) for line in soup.get_text().splitlines() if line.strip())


def diagnostic(value: Any, *, truncated: bool = False, url_policy=None) -> str:
    # Strip HTML attributes (including hidden form credentials) before exposing
    # errors, then redact structured and environment secret values before capping.
    safe = redact(_business_urls(value, url_policy) if url_policy else value)
    text = safe if isinstance(safe, str) else json.dumps(safe, ensure_ascii=False)
    text = html_text(text) if re.search(r"<[a-zA-Z!/][^>]*>", text) else text
    text = redact(text)
    text = re.sub(r"https?://[^\s<>\"']+", lambda m: (url_policy or safe_url)(m.group()), text)
    if len(text) > 2000:
        text, truncated = text[:2000], True
    return text + (" … [truncated]" if truncated else "")


def safe_output(value: Any, *, url_policy=None) -> Any:
    """Keep business HTML evidence while removing embedded secrets at output."""
    value = redact(_business_urls(value, url_policy) if url_policy else value)
    if isinstance(value, dict):
        return {key: safe_output(item, url_policy=url_policy) for key, item in value.items()}
    if isinstance(value, list):
        return [safe_output(item, url_policy=url_policy) for item in value]
    if not isinstance(value, str):
        return value
    value = re.sub(r"(?is)<(script|style|iframe|template)\b[^>]*>.*?</\1\s*>", "[redacted embedded content]", value)
    value = re.sub(r"(?is)<input\b[^>]*>", "[redacted input]", value)
    value = re.sub(r"https?://[^\s<>\"']+", lambda match: (url_policy or safe_url)(match.group()), value)
    return value if len(value) <= 8000 else value[:8000] + " … [truncated]"


def safe_url(value: str) -> str:
    try:
        url = urlsplit(value)
        port = f":{url.port}" if url.port else ""
        return f"{url.scheme}://{url.hostname or ''}{port}{url.path}"
    except ValueError:
        return "[invalid URL redacted]"
