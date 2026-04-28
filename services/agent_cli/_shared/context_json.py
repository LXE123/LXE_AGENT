from __future__ import annotations

import json
from typing import Any


_CONTEXT_KEYS = (
    "store_id",
    "store_name",
    "site",
    "consignment_no",
    "transport_mode",
)
_REQUIRED_CONTEXT_KEYS = (
    "store_id",
    "site",
    "consignment_no",
    "transport_mode",
)


def context_payload(
    *,
    store_id: str = "",
    store_name: str = "",
    site: str = "",
    consignment_no: str = "",
    transport_mode: str = "",
) -> dict[str, str]:
    return {
        "store_id": str(store_id or "").strip(),
        "store_name": str(store_name or "").strip(),
        "site": str(site or "").strip(),
        "consignment_no": str(consignment_no or "").strip(),
        "transport_mode": str(transport_mode or "").strip(),
    }


def merge_context_payloads(*contexts: object) -> dict[str, str]:
    merged = context_payload()
    for item in contexts:
        data = dict(item or {})
        for key in _CONTEXT_KEYS:
            value = str(data.get(key) or "").strip()
            if value:
                merged[key] = value
    return merged


def parse_context_argument(raw_context: object) -> dict[str, str]:
    raw_text = str(raw_context or "").strip()
    if not raw_text:
        raise ValueError("缺少必填参数: --context")
    try:
        parsed = json.loads(raw_text)
    except Exception as exc:
        raise ValueError("--context 必须是 JSON 对象") from exc
    if not isinstance(parsed, dict):
        raise ValueError("--context 必须是 JSON 对象")
    payload = context_payload(
        store_id=parsed.get("store_id") or "",
        store_name=parsed.get("store_name") or "",
        site=parsed.get("site") or "",
        consignment_no=parsed.get("consignment_no") or "",
        transport_mode=parsed.get("transport_mode") or "",
    )
    missing = [key for key in _REQUIRED_CONTEXT_KEYS if not payload.get(key)]
    if missing:
        raise ValueError(f"context 缺少必填字段: {', '.join(missing)}")
    return payload


__all__ = [
    "context_payload",
    "merge_context_payloads",
    "parse_context_argument",
]
