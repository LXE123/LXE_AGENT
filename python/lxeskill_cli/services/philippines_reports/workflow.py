"""Collect or snapshot Philippine sources and publish one complete workbook pair."""

from __future__ import annotations

from datetime import date, datetime
import hashlib
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from typing import Callable
from uuid import uuid4
from zoneinfo import ZoneInfo

from services.mabang_tms import workflow as tms_workflow
from services.yacang import workflow as yacang_workflow
from services.yacang.errors import safe_remote_detail
from shared.datasets import dataset_dir
from shared.filesystem import display_path, filesystem_path
from shared.workspace import resolve_workspace_input

from .errors import PhilippinesReportError
from .workbooks import build_reports


_SOURCES = {
    "sales": ("yacang", "inventory-sales", "PH8805"),
    "inventory": ("yacang", "inventory", "PH8805"),
    "tms": ("mabang-tms", "inventory-sales", "PH1"),
}
_SECRETS = ("LXE_YACANG_MOBILE", "LXE_YACANG_PASSWORD", "LXE_MABANG_TMS_ACCOUNT", "LXE_MABANG_TMS_PASSWORD")


def _today() -> date:
    return datetime.now(ZoneInfo("Asia/Shanghai")).date()


def _safe(value: object) -> str:
    return safe_remote_detail(value, secrets=tuple(os.getenv(name, "") for name in _SECRETS))


def _safe_error(value: object) -> object:
    if isinstance(value, dict):
        return {key: _safe_error(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_safe_error(item) for item in value]
    return _safe(value) if isinstance(value, str) else value


def _failure(stage: str, exc: Exception, source_exports: list[dict] | None = None) -> dict:
    return {
        "success": False, "status": "failed", "stage": stage, "artifacts": [],
        "source_exports": source_exports or [],
        "error": {"code": getattr(exc, "code", "philippines_reports_failed"),
                  "message": _safe(f"{type(exc).__name__}: {exc}")},
    }


def _snapshot(key: str, raw_path: str, directory: Path) -> tuple[Path, dict]:
    path = filesystem_path(resolve_workspace_input(raw_path))
    if path.suffix.lower() != ".xlsx":
        raise PhilippinesReportError("invalid_source", f"{key} 必须是完整导出的 XLSX: {display_path(path)}")
    if not path.is_file():
        raise PhilippinesReportError("source_missing", f"{key} 文件不存在: {display_path(path)}")
    before = path.stat()
    target = directory / f"{key}.xlsx"
    shutil.copyfile(path, target)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise PhilippinesReportError("source_changed", f"复制期间源文件发生变化: {display_path(path)}")
    with target.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    source, report, warehouse = _SOURCES[key]
    return target, {"source": source, "report": report, "warehouse": warehouse,
                    "path": str(display_path(path)), "sha256": digest}


def _merge_files(
    *, sales_file: str, inventory_file: str, tms_file: str | None,
    report_date: date, tms_warehouse_name: str, expected_counts: dict[str, int],
) -> dict:
    root = filesystem_path(dataset_dir("philippines_reports"))
    root.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".building-", dir=root) as temporary:
        temporary = Path(temporary)
        inputs, outputs = temporary / "inputs", temporary / "outputs"
        inputs.mkdir()
        outputs.mkdir()
        paths, sources = {}, []
        for key, raw in (("sales", sales_file), ("inventory", inventory_file), ("tms", tms_file)):
            if key == "tms" and raw is None:
                paths[key] = None
                continue
            paths[key], manifest = _snapshot(key, raw, inputs)
            sources.append(manifest)
        built = build_reports(
            sales_path=paths["sales"], inventory_path=paths["inventory"], tms_path=paths["tms"],
            output_dir=outputs, report_date=report_date, tms_warehouse_name=tms_warehouse_name,
        )
        for field, count in expected_counts.items():
            actual = built["statistics"].get(field)
            if actual != count:
                raise PhilippinesReportError("source_count_mismatch", f"来源元数据 {field}={count}，文件实际为 {actual}")
        artifacts = built["artifacts"]
        destination = root / uuid4().hex
        published = []
        for item in artifacts:
            path = filesystem_path(item["path"])
            published.append({**item, "path": str(display_path(destination / path.name))})
        result = {
            **built, "success": True, "status": "completed",
            "report_date": report_date.isoformat(), "timezone": "Asia/Shanghai",
            "warehouses": {"yacang": "PH8805", "mabang-tms": "PH1"},
            "artifacts": published, "source_files": sources,
            "tms_empty": tms_file is None,
            "source_scope": "雅仓与 TMS 来源均已完成导出，按返回文件校验并合并。",
        }
        # Publish the pair together after all data, counts and output checks pass.
        outputs.rename(destination)
        return result


def _source_summary(source: str, result: dict) -> dict:
    fields = ("success", "status", "warehouse", "warehouse_id", "reported_total", "row_count",
              "source_row_count", "remaining_records", "failed_page", "artifacts", "tasks", "error")
    return {"source": source, **{field: _safe_error(result[field]) for field in fields if field in result}}


def _complete(result: dict, source: str) -> None:
    if result.get("success") is True and result.get("status") == "completed":
        return
    error = result.get("error")
    if isinstance(error, dict) and error.get("message"):
        raise PhilippinesReportError(str(error.get("code") or "source_export_failed"), _safe(error["message"]))
    raise PhilippinesReportError("source_export_incomplete", f"{source} 未完整导出: {_safe(result)}")


def _count(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PhilippinesReportError("source_metadata_invalid", f"{field} 缺少有效非负整数: {value!r}")
    return value


def _yacang_files(result: dict) -> tuple[dict[str, str], dict[str, int]]:
    artifacts = result.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 2:
        raise PhilippinesReportError("source_metadata_invalid", "雅仓应完整提供 PH8805 动销、当前库存两份文件")
    files, counts = {}, {}
    mapping = {"inventory-sales": ("sales_file", "yacang_sales_rows"),
               "inventory-current-snapshot": ("inventory_file", "yacang_inventory_rows")}
    for item in artifacts:
        if (not isinstance(item, dict) or item.get("report") not in mapping or item.get("warehouse") != "PH8805"
                or item.get("created_date") is not None or item.get("source") != "yacang"):
            raise PhilippinesReportError("source_metadata_invalid", "雅仓来源必须为未加创建日期筛选的 PH8805 两份报表")
        key, count_key = mapping[item["report"]]
        path = item.get("path")
        if key in files or not isinstance(path, str) or not path.strip():
            raise PhilippinesReportError("source_metadata_invalid", "雅仓来源报表重复或缺少文件路径")
        files[key] = path
        counts[count_key] = _count(item.get("row_count"), f"雅仓 {item['report']} row_count")
    return files, counts


def _tms_file(result: dict) -> tuple[str | None, str, int]:
    if (result.get("warehouse") != "PH1" or result.get("warehouse_id") != 12107
            or result.get("warehouse_scope") != "selected_warehouse"):
        raise PhilippinesReportError("source_metadata_invalid", "TMS 来源必须为单仓 PH1（12107）")
    total = _count(result.get("reported_total"), "TMS reported_total")
    for field in ("read_unique_ids", "exported_unique_ids"):
        if _count(result.get(field), f"TMS {field}") != total:
            raise PhilippinesReportError("source_export_incomplete", f"TMS {field} 与 reported_total 不一致")
    if _count(result.get("remaining_records"), "TMS remaining_records") != 0:
        raise PhilippinesReportError("source_export_incomplete", "TMS 尚有未导出的接口记录")
    row_count = _count(result.get("row_count"), "TMS row_count")
    source_count = _count(result.get("source_row_count"), "TMS source_row_count")
    distinct = _count(result.get("distinct_skus"), "TMS distinct_skus")
    artifacts = result.get("artifacts")
    if total == 0 and row_count == source_count == distinct == 0 and artifacts == []:
        return None, "菲律宾PH1仓", 0
    if (total == 0 or row_count == 0 or row_count != distinct or source_count < row_count
            or not isinstance(artifacts, list) or len(artifacts) != 1):
        raise PhilippinesReportError("source_metadata_invalid", "TMS PH1 必须提供完整的每 SKU 一行汇总文件")
    item = artifacts[0]
    if (not isinstance(item, dict) or not isinstance(item.get("path"), str) or not item["path"].strip()
            or not isinstance(item.get("warehouse"), str) or not item["warehouse"].strip()
            or _count(item.get("row_count"), "TMS artifact row_count") != row_count):
        raise PhilippinesReportError("source_metadata_invalid", "TMS 汇总文件缺少有效路径、仓库或行数")
    return item["path"], item["warehouse"], row_count


def export_reports(on_event: Callable[[dict], None] = lambda _event: None) -> dict:
    """Export the fixed PH sources once, then merge their validated current paths."""
    stage, source_exports = "yacang_export", []
    try:
        report_date = _today()
        on_event({"stage": stage, "message": "菲律宾报表：取得雅仓 PH8805 库存动销和当前库存"})
        yacang = yacang_workflow.run({"params": {
            "reports": ["inventory-sales", "inventory-current-snapshot"], "warehouses": ["PH8805"],
        }}, require_fresh=True)
        source_exports.append(_source_summary("yacang", yacang))
        _complete(yacang, "雅仓")
        files, counts = _yacang_files(yacang)
        stage = "tms_export"
        on_event({"stage": stage, "message": "菲律宾报表：取得马帮 TMS PH1 SKU 汇总"})
        tms = tms_workflow.run_with_events({"warehouse": "PH1"}, on_event)
        source_exports.append(_source_summary("mabang-tms", tms))
        _complete(tms, "马帮 TMS")
        tms_file, warehouse_name, tms_count = _tms_file(tms)
        stage = "merge"
        on_event({"stage": stage, "message": "菲律宾报表：按 SKU 合并并校验两份工作簿"})
        result = _merge_files(**files, tms_file=tms_file, report_date=report_date,
                              tms_warehouse_name=warehouse_name, expected_counts={**counts, "tms_rows": tms_count})
        return {**result, "source_exports": source_exports}
    except Exception as exc:
        return _failure(stage, exc, source_exports)
