from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from services.yacang.client import YacangClient
from services.yacang.exports.inventory_sales import (
    DEFAULT_CACHE_MAX_AGE_SECONDS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
    ExportRequest,
    export_inventory_sales_requests,
)
from services.yacang.submission import SubmissionBackend
from services.yacang.warehouses import select_warehouses


DEFAULT_SOURCE_RANGE_DAYS = 0


@dataclass(frozen=True)
class InventorySalesSourceBatch:
    created_start_date: str
    created_end_date: str
    results: tuple[dict[str, Any], ...]


def resolve_source_date_range(
    *,
    start_date: Any = None,
    end_date: Any = None,
    as_of_date: Any = None,
    today: Callable[[], date] = date.today,
) -> tuple[date, date]:
    explicit_start = str(start_date or "").strip()
    explicit_end = str(end_date or "").strip()
    if bool(explicit_start) != bool(explicit_end):
        raise ValueError("start_date 和 end_date 必须同时提供")
    if as_of_date is not None and (explicit_start or explicit_end):
        raise ValueError("as_of_date 不能与 start_date/end_date 同时提供")
    if explicit_start:
        start = date.fromisoformat(explicit_start)
        end = date.fromisoformat(explicit_end)
        if start > end:
            raise ValueError("start_date 不能晚于 end_date")
        return start, end
    end = date.fromisoformat(str(as_of_date or today().isoformat()).strip())
    return end - timedelta(days=DEFAULT_SOURCE_RANGE_DAYS), end


def acquire_inventory_sales_sources(
    source_fetches: Sequence[Mapping[str, Any]] | None = None,
    *,
    as_of_date: Any = None,
    start_date: Any = None,
    end_date: Any = None,
    warehouses: Any = None,
    mobile: str | None = None,
    password: str | None = None,
    output_dir: str | Path,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    cache_max_age_seconds: float = DEFAULT_CACHE_MAX_AGE_SECONDS,
    client: YacangClient | None = None,
    submission_store: SubmissionBackend | None = None,
    sleep: Callable[[float], None] | None = None,
    today: Callable[[], date] = date.today,
) -> InventorySalesSourceBatch:
    if source_fetches is None:
        start, end = resolve_source_date_range(
            start_date=start_date,
            end_date=end_date,
            as_of_date=as_of_date,
            today=today,
        )
        selected_warehouses = select_warehouses(warehouses)
        source_fetch_ids = {
            warehouse.code: sales_source_fetch_id(warehouse.code, start.isoformat(), end.isoformat())
            for warehouse in selected_warehouses
        }
    else:
        if any(value is not None for value in (as_of_date, start_date, end_date, warehouses)):
            raise ValueError("source_fetches 不能与日期或仓库参数同时提供")
        start, end, selected_warehouses, source_fetch_ids = _planned_source_requests(source_fetches)

    requests = [
        ExportRequest(
            warehouse_code=warehouse.code,
            warehouse_id=warehouse.warehouse_id,
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            output_filename=(
                f"yacang_inventory_sales_source_{warehouse.code}_"
                f"{start.isoformat()}_{end.isoformat()}.xlsx"
            ),
            business_key="inventory-sales-source",
        )
        for warehouse in selected_warehouses
    ]
    kwargs: dict[str, Any] = {}
    if sleep is not None:
        kwargs["sleep"] = sleep
    results = export_inventory_sales_requests(
        requests,
        dataset_id="yacang_exports",
        mobile=mobile,
        password=password,
        output_dir=Path(output_dir) / ".source-cache",
        timeout_seconds=timeout_seconds,
        poll_interval_seconds=poll_interval_seconds,
        cache_max_age_seconds=cache_max_age_seconds,
        client=client,
        submission_store=submission_store,
        **kwargs,
    )
    enriched = tuple(
        {
            **result,
            "source_fetch_id": source_fetch_ids[str(result["warehouse"])],
        }
        for result in results
    )
    return InventorySalesSourceBatch(
        created_start_date=start.isoformat(),
        created_end_date=end.isoformat(),
        results=enriched,
    )


def download_inventory_sales_sources(
    *,
    as_of_date: Any = None,
    start_date: Any = None,
    end_date: Any = None,
    warehouses: Any = None,
    mobile: str | None = None,
    password: str | None = None,
    output_dir: str | Path,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    cache_max_age_seconds: float = DEFAULT_CACHE_MAX_AGE_SECONDS,
    client: YacangClient | None = None,
    submission_store: SubmissionBackend | None = None,
    sleep: Callable[[float], None] | None = None,
    today: Callable[[], date] = date.today,
) -> tuple[date, list[dict[str, Any]]]:
    batch = acquire_inventory_sales_sources(
        as_of_date=as_of_date,
        start_date=start_date,
        end_date=end_date,
        warehouses=warehouses,
        mobile=mobile,
        password=password,
        output_dir=output_dir,
        timeout_seconds=timeout_seconds,
        poll_interval_seconds=poll_interval_seconds,
        cache_max_age_seconds=cache_max_age_seconds,
        client=client,
        submission_store=submission_store,
        sleep=sleep,
        today=today,
    )
    return date.fromisoformat(batch.created_end_date), list(batch.results)


def _planned_source_requests(
    source_fetches: Sequence[Mapping[str, Any]],
) -> tuple[date, date, tuple[Any, ...], dict[str, str]]:
    if not source_fetches:
        raise ValueError("source_fetches 至少需要一个物理销量源")
    fetch_ids: dict[str, str] = {}
    start: date | None = None
    end: date | None = None
    for fetch in source_fetches:
        if fetch.get("source_type") != "inventory-sales-source":
            raise ValueError("source_fetches 只能包含 inventory-sales-source")
        parameters = fetch.get("effective_parameters")
        if not isinstance(parameters, Mapping):
            raise ValueError("source_fetch.effective_parameters 必须是对象")
        warehouse = str(parameters.get("warehouse") or "").strip().upper()
        if warehouse != str(fetch.get("warehouse") or "").strip().upper():
            raise ValueError("source_fetch warehouse 与 effective_parameters 不一致")
        created = parameters.get("created_date_filter")
        if not isinstance(created, Mapping):
            raise ValueError("销量 source_fetch 必须包含 created_date_filter")
        current_start, current_end = resolve_source_date_range(
            start_date=created.get("created_start_date"),
            end_date=created.get("created_end_date"),
        )
        if start is None:
            start, end = current_start, current_end
        elif (start, end) != (current_start, current_end):
            raise ValueError("同一 source batch 的商品创建日期范围必须一致")
        expected_id = sales_source_fetch_id(warehouse, current_start.isoformat(), current_end.isoformat())
        actual_id = str(fetch.get("source_fetch_id") or "")
        if actual_id != expected_id:
            raise ValueError("source_fetch_id 与仓库及商品创建日期范围不一致")
        previous = fetch_ids.setdefault(warehouse, actual_id)
        if previous != actual_id:
            raise ValueError("同一仓库存在冲突的 source_fetch_id")

    assert start is not None and end is not None
    selected_warehouses = select_warehouses(list(fetch_ids))
    return start, end, selected_warehouses, fetch_ids


def sales_source_fetch_id(
    warehouse_code: str,
    created_start_date: str,
    created_end_date: str,
) -> str:
    return f"inventory-sales-source:{warehouse_code}:{created_start_date}:{created_end_date}"


__all__ = [
    "DEFAULT_SOURCE_RANGE_DAYS",
    "InventorySalesSourceBatch",
    "acquire_inventory_sales_sources",
    "download_inventory_sales_sources",
    "resolve_source_date_range",
    "sales_source_fetch_id",
]
