from __future__ import annotations

import json
from pathlib import Path
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


def _parse_context_payload(parsed: Any) -> dict[str, str]:
    if not isinstance(parsed, dict):
        raise ValueError("--context-file 必须指向 JSON 对象文件")
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


def parse_context_file_argument(raw_context_file: object) -> dict[str, str]:
    raw_path = str(raw_context_file or "").strip()
    if not raw_path:
        raise ValueError("缺少必填参数: --context-file")
    path = Path(raw_path)
    try:
        raw_text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError as exc:
        raise ValueError(f"context 文件不存在: {raw_path}") from exc
    except OSError as exc:
        raise ValueError(f"context 文件读取失败: {exc}") from exc
    try:
        parsed = json.loads(raw_text)
    except Exception as exc:
        raise ValueError("--context-file 必须指向 JSON 对象文件") from exc
    return _parse_context_payload(parsed)


__all__ = [
    "context_payload",
    "merge_context_payloads",
    "parse_context_file_argument",
]
