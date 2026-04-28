"""Canonical transport mode definitions."""

from __future__ import annotations

import re
from typing import Any

TRANSPORT_MODE_ALIASES: dict[str, str] = {
    "air": "air",
    "空运": "air",
    "sea": "sea",
    "海运": "sea",
    "sea_matson": "sea_matson",
    "海运快船": "sea_matson",
    "海运美森": "sea_matson",
    "美森海运": "sea_matson",
    "美森": "sea_matson",
    "快船": "sea_matson",
    "matson": "sea_matson",
    "sea_non_matson": "sea_non_matson",
    "海运慢船": "sea_non_matson",
    "非美森海运": "sea_non_matson",
    "慢船": "sea_non_matson",
}

TRANSPORT_MODE_LABELS: dict[str, str] = {
    "air": "空运",
    "sea": "海运",
    "sea_matson": "海运快船",
    "sea_non_matson": "海运慢船",
}


def normalize_transport_mode(value: Any) -> str | None:
    token = re.sub(r"\s+", "", str(value or "").strip().lower())
    if not token:
        return None
    return TRANSPORT_MODE_ALIASES.get(token)


def resolve_base_transport_mode(transport_mode: Any, default: str = "air") -> str:
    normalized = normalize_transport_mode(transport_mode) or normalize_transport_mode(default) or "air"
    return "air" if normalized == "air" else "sea"


def transport_mode_label(value: Any) -> str:
    normalized = normalize_transport_mode(value)
    if normalized:
        return TRANSPORT_MODE_LABELS.get(normalized, normalized)
    text = str(value or "").strip()
    return text or "-"

