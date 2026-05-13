from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio

SOURCE = "customs_declaration_fill"
DEFAULT_TEMPLATE_PATH = Path("data") / "customs_declaration" / "custom_declaration_documents.xlsx"
DEFAULT_OUTPUT_DIR = Path("artifacts") / "customs_declaration"

INPUT_HEADERS = (
    "日期",
    "SKU",
    "品名",
    "规格型号",
    "发货量",
    "单价",
    "供货商",
    "采购订单号",
    "采购总价",
    "商品名称",
    "售价",
    "总价",
    "单位",
)
TARGET_HEADERS = (
    "序号",
    "品名",
    "海关HS编码",
    "检疫附加码",
    "品牌",
    "型号",
    "品牌类型",
    "出口享惠情况",
    "其他申报要素",
)
SP_NO_PATTERN = re.compile(r"(SP\d+)", re.IGNORECASE)


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


@dataclass(frozen=True)
class SourceDeclarationRow:
    row_number: int
    source_name: str
    model: str
    quantity: Any
    commodity_name: str
    sale_price: Any
    total_price: Any
    unit: str


@dataclass(frozen=True)
class ClassificationResult:
    hs_code: str
    declaration_element: str


def _write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


def _clean_cell(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower() == "nan":
        return ""
    return text


def extract_sp_no_from_filename(path: str | Path) -> str:
    name = Path(path).name
    match = SP_NO_PATTERN.search(name)
    if not match:
        raise ValueError(f"文件名中缺少 SP 单号: {name}")
    return match.group(1).upper()


def _load_workbook(path: Path, *, data_only: bool = False):
    try:
        from openpyxl import load_workbook
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 依赖，无法处理 xlsx 文件") from exc

    try:
        return load_workbook(path, data_only=data_only)
    except Exception as exc:
        raise RuntimeError(f"读取 xlsx 文件失败: {path}, error={exc}") from exc


def _validate_input_headers(actual_headers: list[str]) -> None:
    expected = list(INPUT_HEADERS)
    actual = actual_headers[: len(expected)]
    if actual != expected:
        raise ValueError(
            "第 3 个 sheet 第 1 行表头不匹配，"
            f"expected={expected}, actual={actual}"
        )


def read_source_rows(input_xlsx: str | Path) -> list[SourceDeclarationRow]:
    path = Path(input_xlsx)
    if not path.is_file():
        raise FileNotFoundError(f"输入 xlsx 不存在: {path}")

    workbook = _load_workbook(path, data_only=True)
    if len(workbook.worksheets) < 3:
        raise ValueError("输入 workbook 少于 3 个 sheet")

    worksheet = workbook.worksheets[2]
    headers = [_clean_cell(worksheet.cell(row=1, column=index).value) for index in range(1, len(INPUT_HEADERS) + 1)]
    _validate_input_headers(headers)
    column_indexes = {header: index + 1 for index, header in enumerate(INPUT_HEADERS)}

    rows: list[SourceDeclarationRow] = []
    for row_number in range(2, worksheet.max_row + 1):
        if not _clean_cell(worksheet.cell(row=row_number, column=column_indexes["日期"]).value):
            break
        rows.append(
            SourceDeclarationRow(
                row_number=row_number,
                source_name=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["品名"]).value),
                model=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["规格型号"]).value),
                quantity=worksheet.cell(row=row_number, column=column_indexes["发货量"]).value,
                commodity_name=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["商品名称"]).value),
                sale_price=worksheet.cell(row=row_number, column=column_indexes["售价"]).value,
                total_price=worksheet.cell(row=row_number, column=column_indexes["总价"]).value,
                unit=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["单位"]).value),
            )
        )

    if not rows:
        raise ValueError("输入 xlsx 第 3 个 sheet 未解析到有效数据")
    return rows


def classify_declaration(row: SourceDeclarationRow) -> ClassificationResult:
    commodity_name = row.commodity_name
    source_name = row.source_name
    source_name_upper = source_name.upper()

    if "表带" in commodity_name:
        if "米兰尼斯" in source_name:
            return ClassificationResult("9113200000", "贱金属")
        if "编织" in source_name or "尼龙" in source_name:
            return ClassificationResult("9113900090", "尼龙")
        if "真皮" in source_name:
            return ClassificationResult("9113900090", "真皮")
        if "硅胶" in source_name:
            return ClassificationResult("9113900090", "硅胶")
        return ClassificationResult("", "")

    if "表壳" in commodity_name:
        if "金属" in source_name:
            return ClassificationResult("9111800000", "贱金属")
        if "PC" in source_name_upper:
            return ClassificationResult("9111800000", "PC")
        if "TPU" in source_name_upper:
            return ClassificationResult("9111800000", "TPU")
        return ClassificationResult("9111800000", "PC")

    if "包装盒" in commodity_name:
        return ClassificationResult("4819200000", "纸质+塑料")

    if "手表保护套" in commodity_name:
        if "PC" in source_name_upper:
            return ClassificationResult("3926909090", "PC")
        if "TPU" in source_name_upper:
            return ClassificationResult("3926909090", "TPU")
        return ClassificationResult("3926909090", "PC")

    return ClassificationResult("", "")


def _find_target_header_row(worksheet: Any) -> int:
    expected = list(TARGET_HEADERS)
    for row_index in range(1, worksheet.max_row + 1):
        headers = [
            _clean_cell(worksheet.cell(row=row_index, column=column_index).value)
            for column_index in range(1, len(expected) + 1)
        ]
        if headers == expected:
            return row_index
    raise ValueError(f"模板申报要素 sheet 缺少表头: {expected}")


def _clear_old_declaration_rows(worksheet: Any, *, header_row: int) -> None:
    for row_index in range(header_row + 1, worksheet.max_row + 1):
        for column_index in range(1, len(TARGET_HEADERS) + 1):
            worksheet.cell(row=row_index, column=column_index).value = None


def _write_declaration_rows(worksheet: Any, *, header_row: int, rows: list[SourceDeclarationRow]) -> list[str]:
    header_to_col = {header: index + 1 for index, header in enumerate(TARGET_HEADERS)}
    notice: list[str] = []

    for offset, row in enumerate(rows, start=1):
        target_row = header_row + offset
        classification = classify_declaration(row)
        if not classification.hs_code or not classification.declaration_element:
            notice.append(
                f"第{row.row_number}行未匹配申报规则: "
                f"商品名称={row.commodity_name}, 品名={row.source_name}"
            )

        worksheet.cell(row=target_row, column=header_to_col["序号"], value=offset)
        worksheet.cell(row=target_row, column=header_to_col["品名"], value=row.commodity_name)
        worksheet.cell(row=target_row, column=header_to_col["海关HS编码"]).value = classification.hs_code or None
        worksheet.cell(row=target_row, column=header_to_col["检疫附加码"]).value = None
        worksheet.cell(row=target_row, column=header_to_col["品牌"], value="0无品牌")
        worksheet.cell(row=target_row, column=header_to_col["型号"], value=row.model)
        worksheet.cell(row=target_row, column=header_to_col["品牌类型"], value="0无品牌")
        worksheet.cell(row=target_row, column=header_to_col["出口享惠情况"], value="0不享惠")
        worksheet.cell(row=target_row, column=header_to_col["其他申报要素"]).value = (
            classification.declaration_element or None
        )

    return notice


def fill_customs_declaration(
    input_xlsx: str | Path,
    *,
    template_xlsx: str | Path | None = None,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    input_path = Path(input_xlsx)
    sp_no = extract_sp_no_from_filename(input_path)
    source_rows = read_source_rows(input_path)

    template_path = Path(DEFAULT_TEMPLATE_PATH if template_xlsx is None else template_xlsx)
    if not template_path.is_file():
        raise FileNotFoundError(f"报关资料模板不存在: {template_path}")

    directory = Path(DEFAULT_OUTPUT_DIR if output_dir is None else output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    output_path = directory / f"{sp_no}_custom_declaration_documents.xlsx"
    shutil.copy2(template_path, output_path)

    workbook = _load_workbook(output_path)
    if "申报要素" not in workbook.sheetnames:
        raise ValueError("报关资料模板缺少 sheet: 申报要素")

    worksheet = workbook["申报要素"]
    header_row = _find_target_header_row(worksheet)
    _clear_old_declaration_rows(worksheet, header_row=header_row)
    notice = _write_declaration_rows(worksheet, header_row=header_row, rows=source_rows)
    workbook.save(output_path)

    return {
        "success": True,
        "sp_no": sp_no,
        "input_xlsx": str(input_path),
        "output_xlsx": str(output_path),
        "row_count": len(source_rows),
        "unmatched_count": len(notice),
        "notice": notice,
        "source": SOURCE,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.fill_customs_declaration"
    )
    parser.add_argument("--input-xlsx", required=True)
    parser.add_argument("--template-xlsx", default=str(DEFAULT_TEMPLATE_PATH))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    return parser


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    try:
        args = build_parser().parse_args(argv)
        payload = fill_customs_declaration(
            getattr(args, "input_xlsx", ""),
            template_xlsx=getattr(args, "template_xlsx", ""),
            output_dir=getattr(args, "output_dir", ""),
        )
    except Exception as exc:
        payload = {
            "success": False,
            "exception": _exception_text(exc),
        }

    _write_json(payload)
    return 0 if bool(payload.get("success")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
