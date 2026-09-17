from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any, Callable

from services.yacang.client import YacangClient
from services.yacang.exports.inventory_sales import (
    DEFAULT_CACHE_MAX_AGE_SECONDS,
    DEFAULT_POLL_INTERVAL_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
)
from services.yacang.exports.sales_source import (
    InventorySalesSourceBatch,
    acquire_inventory_sales_sources,
)
from services.yacang.naming import SALES_MONTHLY_WINDOWS, YacangExportKind, export_filename
from services.yacang.projection import SALES_MONTHLY_HEADERS, project_inventory_sales_workbook
from services.yacang.reporting import failed_export, successful_export, summarize_exports
from services.yacang.submission import SubmissionBackend
from services.yacang.warehouses import select_warehouses
from shared.datasets import dataset_dir


def export_sales_monthly(
    *,
    as_of_date: Any = None,
    start_date: Any = None,
    end_date: Any = None,
    warehouses: Any = None,
    mobile: str | None = None,
    password: str | None = None,
    output_dir: str | Path | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    cache_max_age_seconds: float = DEFAULT_CACHE_MAX_AGE_SECONDS,
    client: YacangClient | None = None,
    submission_store: SubmissionBackend | None = None,
    sleep: Callable[[float], None] | None = None,
    today: Callable[[], date] = date.today,
) -> dict[str, Any]:
    destination_dir = Path(output_dir) if output_dir is not None else dataset_dir("yacang_exports")
    source_batch = acquire_inventory_sales_sources(
        as_of_date=as_of_date,
        start_date=start_date,
        end_date=end_date,
        warehouses=warehouses,
        mobile=mobile,
        password=password,
        output_dir=destination_dir,
        timeout_seconds=timeout_seconds,
        poll_interval_seconds=poll_interval_seconds,
        cache_max_age_seconds=cache_max_age_seconds,
        client=client,
        submission_store=submission_store,
        sleep=sleep,
        today=today,
    )
    return project_sales_monthly_sources(
        source_batch,
        warehouses=warehouses,
        output_dir=destination_dir,
    )


def project_sales_monthly_sources(
    source_batch: InventorySalesSourceBatch,
    *,
    warehouses: Any = None,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    destination_dir = Path(output_dir) if output_dir is not None else dataset_dir("yacang_exports")
    source_by_warehouse = {str(item["warehouse"]): item for item in source_batch.results}
    selected_warehouses = select_warehouses(
        warehouses if warehouses is not None else list(source_by_warehouse)
    )
    exports: list[dict[str, Any]] = []
    for warehouse in selected_warehouses:
        source = source_by_warehouse[warehouse.code]
        path = destination_dir / export_filename(
            YacangExportKind.SALES_MONTHLY,
            warehouse_code=warehouse.code,
            file_date=source_batch.created_end_date,
        )
        context = {
            "business_type": YacangExportKind.SALES_MONTHLY.value,
            "warehouse": warehouse.code,
            "warehouse_id": warehouse.warehouse_id,
            "as_of_date": source_batch.created_end_date,
            "sales_window_days": list(SALES_MONTHLY_WINDOWS),
            "output_filename": path.name,
            "source_fetch_id": source.get("source_fetch_id"),
        }
        if source.get("status") != "success":
            exports.append({
                **context,
                "status": source.get("status", "failed"),
                **{
                    key: source.get(key)
                    for key in ("error_code", "stage", "http_status", "error_type", "error")
                },
            })
            continue
        try:
            row_count = project_inventory_sales_workbook(
                Path(str(source["xlsx_path"])),
                path,
                headers=SALES_MONTHLY_HEADERS,
                warehouse_code=warehouse.code,
            )
            exports.append(successful_export({
                **context,
                "xlsx_path": str(path),
                "row_count": row_count,
                "source": source["source"],
            }))
        except Exception as exc:
            path.unlink(missing_ok=True)
            exports.append(failed_export(context, exc))
    summary = summarize_exports(exports)
    return {
        **summary,
        "business_type": YacangExportKind.SALES_MONTHLY.value,
        "sales_window_days": list(SALES_MONTHLY_WINDOWS),
        "as_of_date": source_batch.created_end_date,
        "warehouse_count": len(selected_warehouses),
    }


__all__ = ["export_sales_monthly", "project_sales_monthly_sources"]
