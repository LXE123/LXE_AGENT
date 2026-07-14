from __future__ import annotations

import asyncio
from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba import download_fba_delivery_csv
from services.mabang.amazon.fba.batch_delivery import normalize_delivery_no


def _require_delivery_no(value: Any) -> str:
    delivery_no = normalize_delivery_no(value)
    if not delivery_no:
        raise ValueError("delivery_no 不能为空")
    if not delivery_no.startswith("SP"):
        raise ValueError(f"delivery_no 格式无效: {delivery_no}")
    return delivery_no


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    delivery_no = ""
    try:
        raw = str(arguments.get("delivery_no") or "")
        delivery_no = normalize_delivery_no(raw)
        timeout_sec = arguments.get("timeout_sec")
        poll_interval_sec = arguments.get("poll_interval_sec")
        result = asyncio.run(download_fba_delivery_csv(
            _require_delivery_no(raw),
            timeout_sec=float(180 if timeout_sec is None else timeout_sec),
            poll_interval_sec=float(10 if poll_interval_sec is None else poll_interval_sec),
        ))
        return result.to_payload()
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "delivery_no": delivery_no,
            "exception": _exception_text(exc),
        }
