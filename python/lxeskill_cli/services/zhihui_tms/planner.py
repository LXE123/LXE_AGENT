from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .intent import ZhihuiTmsProductExportIntent, normalize_product_export_intent
from .product_export import (
    DEFAULT_MAX_PAGES,
    DEFAULT_MAX_RECORDS,
    DEFAULT_MAX_REQUESTS,
    DEFAULT_MAX_RUNTIME,
    PAGE_SIZE,
)


@dataclass(frozen=True)
class ZhihuiTmsProductExportPlan:
    intent: ZhihuiTmsProductExportIntent
    action: str
    date_label: str
    page_size: int = PAGE_SIZE
    max_pages: int = DEFAULT_MAX_PAGES
    max_records: int = DEFAULT_MAX_RECORDS
    max_requests: int = DEFAULT_MAX_REQUESTS
    max_runtime: float = DEFAULT_MAX_RUNTIME


def plan_product_export(
    arguments: dict[str, Any], *, action: str, date_label: str | None = None,
) -> ZhihuiTmsProductExportPlan:
    if action not in {"preview", "execute"}:
        raise ValueError("action 只允许 preview 或 execute")
    intent = normalize_product_export_intent(arguments)
    label = date_label or datetime.now().strftime("%Y%m%d")
    if len(label) != 8 or not label.isdigit():
        raise ValueError("date_label 必须是 YYYYMMDD")
    try:
        datetime.strptime(label, "%Y%m%d")
    except ValueError as exc:
        raise ValueError("date_label 必须是有效的 YYYYMMDD 日期") from exc
    return ZhihuiTmsProductExportPlan(intent=intent, action=action, date_label=label)


__all__ = ["ZhihuiTmsProductExportPlan", "plan_product_export"]
