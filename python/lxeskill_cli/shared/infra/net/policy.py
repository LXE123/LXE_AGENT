from __future__ import annotations

import os
import sys
import urllib.request
from typing import Callable, Mapping


_PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)
_NO_PROXY_ENV_KEYS = ("NO_PROXY", "no_proxy")
_DEFAULT_MODE = "direct"


def _default_emit(message: str) -> None:
    print(message, file=sys.stderr)


def _clean_direct_network_env(env: Mapping[str, str] | None = None) -> dict[str, str]:
    cleaned = dict(env or os.environ)
    for key in _PROXY_ENV_KEYS:
        cleaned.pop(key, None)
    cleaned["NO_PROXY"] = "*"
    cleaned["no_proxy"] = "*"
    return cleaned


def network_snapshot() -> dict[str, object]:
    return {
        "mode": _DEFAULT_MODE,
        "env": {key: os.environ.get(key, "") for key in (*_PROXY_ENV_KEYS, *_NO_PROXY_ENV_KEYS)},
        "urllib_proxies": dict(urllib.request.getproxies() or {}),
    }


def log_network_snapshot(
    label: str = "process",
    *,
    emit: Callable[[str], None] | None = None,
) -> dict[str, object]:
    snapshot = network_snapshot()
    writer = emit or _default_emit
    writer(
        "[NetPolicy] label=%s mode=%s env=%s urllib_proxies=%s"
        % (
            str(label or "process").strip(),
            snapshot["mode"],
            snapshot["env"],
            snapshot["urllib_proxies"],
        )
    )
    return snapshot


def bootstrap_network_policy(
    label: str = "process",
    *,
    emit: Callable[[str], None] | None = None,
) -> dict[str, object]:
    cleaned = _clean_direct_network_env()
    for key in list(os.environ.keys()):
        if key in _PROXY_ENV_KEYS:
            os.environ.pop(key, None)
    os.environ.update({key: cleaned[key] for key in _NO_PROXY_ENV_KEYS})
    return log_network_snapshot(label=label, emit=emit)


def build_child_env(*, extra_env: Mapping[str, str] | None = None) -> dict[str, str]:
    env = _clean_direct_network_env()
    if extra_env:
        for key, value in dict(extra_env).items():
            env[str(key)] = str(value)
    return env


__all__ = [
    "bootstrap_network_policy",
    "build_child_env",
    "log_network_snapshot",
    "network_snapshot",
]
