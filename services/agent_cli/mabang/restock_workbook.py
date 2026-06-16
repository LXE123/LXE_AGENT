from __future__ import annotations

from pathlib import Path
from typing import Any

SUMMARY_WORKSHEET_NAME = "汇总表"
SUMMARY_HEADERS = (
    "日期",
    "SKU",
    "品名",
    "规格型号",
    "发货量",
    "单价",
    "采购总价",
    "商品名称",
    "售价",
    "总价",
    "单位",
)
MERGE_DETAIL_HEADERS = ("SKU", "产品名称", "发货量", "规则型号", "单价")


def clean_cell(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower() == "nan":
        return ""
    return text


def worksheet_headers(worksheet: Any, count: int) -> list[str]:
    return [clean_cell(worksheet.cell(row=1, column=index).value) for index in range(1, count + 1)]


def _format_sheet_summaries(workbook: Any, *, header_count: int) -> str:
    summaries: list[str] = []
    for worksheet in workbook.worksheets:
        count = max(header_count, int(getattr(worksheet, "max_column", 0) or 0))
        headers = worksheet_headers(worksheet, count)
        summaries.append(f"{worksheet.title}: {headers}")
    return "; ".join(summaries)


def _workbook_sheet_names(workbook: Any) -> str:
    return ", ".join(str(name) for name in workbook.sheetnames)


def _summary_header_set(worksheet: Any) -> set[str]:
    headers: set[str] = set()
    max_column = int(getattr(worksheet, "max_column", 0) or 0)
    for column_index in range(1, max_column + 1):
        header = clean_cell(worksheet.cell(row=1, column=column_index).value)
        if header:
            headers.add(header)
    return headers


def _has_required_summary_headers(worksheet: Any) -> bool:
    return set(SUMMARY_HEADERS).issubset(_summary_header_set(worksheet))


def summary_column_indexes(
    worksheet: Any,
    *,
    input_path: str | Path,
    sheet_name: str = "",
) -> dict[str, int]:
    path = Path(input_path)
    title = str(sheet_name or getattr(worksheet, "title", "") or "")
    indexes: dict[str, int] = {}
    duplicate_headers: list[str] = []
    max_column = int(getattr(worksheet, "max_column", 0) or 0)

    for column_index in range(1, max_column + 1):
        header = clean_cell(worksheet.cell(row=1, column=column_index).value)
        if header not in SUMMARY_HEADERS:
            continue
        if header in indexes:
            duplicate_headers.append(header)
            continue
        indexes[header] = column_index

    if duplicate_headers:
        duplicate_text = ", ".join(dict.fromkeys(duplicate_headers))
        raise ValueError(
            f"文件 {path.name} 的 sheet {title} 第 1 行汇总表表头重复: {duplicate_text}"
        )

    missing = [header for header in SUMMARY_HEADERS if header not in indexes]
    if missing:
        raise ValueError(
            f"文件 {path.name} 的 sheet {title} 汇总表缺少必需表头: {', '.join(missing)}"
        )

    return indexes


def find_summary_sheet(workbook: Any, input_path: str | Path):
    path = Path(input_path)
    if SUMMARY_WORKSHEET_NAME in workbook.sheetnames:
        return workbook[SUMMARY_WORKSHEET_NAME]

    candidates = [
        worksheet
        for worksheet in workbook.worksheets
        if _has_required_summary_headers(worksheet)
    ]
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        candidate_names = ", ".join(worksheet.title for worksheet in candidates)
        raise ValueError(
            f"备货单存在多个汇总表候选 sheet: file={path.name}, candidates={candidate_names}"
        )

    raise ValueError(
        f"备货单缺少 {SUMMARY_WORKSHEET_NAME} sheet，且没有找到汇总表表头: "
        f"file={path.name}, sheets=[{_workbook_sheet_names(workbook)}], "
        f"headers={_format_sheet_summaries(workbook, header_count=len(SUMMARY_HEADERS))}"
    )


def find_merge_detail_sheet(workbook: Any, input_path: str | Path):
    path = Path(input_path)
    candidates = [
        worksheet
        for worksheet in workbook.worksheets
        if worksheet_headers(worksheet, len(MERGE_DETAIL_HEADERS)) == list(MERGE_DETAIL_HEADERS)
    ]
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        candidate_names = ", ".join(worksheet.title for worksheet in candidates)
        raise ValueError(
            f"备货单存在多个财务合并明细表候选 sheet: file={path.name}, candidates={candidate_names}"
        )

    raise ValueError(
        f"备货单缺少财务合并明细表，未找到表头: {list(MERGE_DETAIL_HEADERS)}; "
        f"file={path.name}, sheets=[{_workbook_sheet_names(workbook)}], "
        f"headers={_format_sheet_summaries(workbook, header_count=len(MERGE_DETAIL_HEADERS))}"
    )
