from __future__ import annotations

import argparse
import asyncio
import copy
import json
import sys
from collections import OrderedDict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from io import BytesIO
from pathlib import Path
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.agent_cli.mabang.fill_customs_declaration import (
    INPUT_HEADERS,
    SourceDeclarationRow,
    _clean_cell,
    classify_declaration,
    extract_destination_country_from_filename,
    extract_sp_no_from_filename,
)
from services.mabang.stock_sku_export import (
    STOCK_SKU_COLUMN,
    export_stock_sku_names,
    normalize_sku_key,
)
from shared.infra.net import close_all_network_clients

SOURCE = "invoice_template_fill"
DEFAULT_TEMPLATE_PATH = Path("data") / "invoice_Template" / "invoice_Template.xlsx"
DEFAULT_OUTPUT_DIR = Path("artifacts") / "invoice_template"
STOCK_SKU_OUTPUT_DIR = Path("artifacts") / "mabang_stock_sku"
INVOICE_TEMPLATE_SHEET = "WS-通用发票导入模版"
STOCK_SKU_IMAGE_COLUMN = "库存sku图片"
IMAGE_MAX_WIDTH = 80
IMAGE_MAX_HEIGHT = 80
IMAGE_ROW_HEIGHT = 65
IMAGE_COLUMN_WIDTH = 14
UNKNOWN_DECLARED_PRICE_TEXT = "没有该材质的计算价格方式"
MATERIAL_TRANSLATIONS = {
    "硅胶": "silicone",
    "尼龙": "nylon",
    "贱金属": "base metal",
    "金属": "metal",
    "纸质+塑料": "paper+plastic",
    "皮革": "leather",
    "PC": "PC",
    "TPU": "TPU",
}

INVOICE_TEMPLATE_HEADERS = (
    "货箱编号*",
    "PO Number*",
    "单件货箱重量(KG)*",
    "货箱长度(CM)*",
    "货箱宽度(CM)*",
    "货箱高度(CM)*",
    "产品英文品名*",
    "产品中文品名*",
    "产品申报单价*",
    "单箱产品申报数量*",
    "单位*",
    "产品材质*",
    "产品海关编码*",
    "产品用途*",
    "产品品牌*",
    "品牌类型*",
    "产品型号*",
    "产品销售链接*",
    "产品图片*",
    "预计配送时间段*",
)


@dataclass(frozen=True)
class InvoiceSourceRow:
    row_number: int
    sku: str
    source_name: str
    model: str
    quantity: Any
    commodity_name: str
    sale_price: Any
    total_price: Any
    unit: str

    def to_declaration_row(self) -> SourceDeclarationRow:
        return SourceDeclarationRow(
            row_number=self.row_number,
            source_name=self.source_name,
            model=self.model,
            quantity=self.quantity,
            commodity_name=self.commodity_name,
            sale_price=self.sale_price,
            total_price=self.total_price,
            unit=self.unit,
        )


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def _write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


def _load_workbook(path: str | Path, *, data_only: bool = False):
    try:
        from openpyxl import load_workbook
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 依赖，无法处理 xlsx 文件") from exc

    source_path = Path(path).expanduser()
    try:
        return load_workbook(source_path, data_only=data_only)
    except Exception as exc:
        raise RuntimeError(f"读取 xlsx 文件失败: {source_path}, error={exc}") from exc


def _validate_input_headers(actual_headers: list[str]) -> None:
    expected = list(INPUT_HEADERS)
    actual = actual_headers[: len(expected)]
    if actual != expected:
        raise ValueError(
            "第 3 个 sheet 第 1 行表头不匹配，"
            f"expected={expected}, actual={actual}"
        )


def read_invoice_source_rows(input_xlsx: str | Path) -> list[InvoiceSourceRow]:
    path = Path(input_xlsx).expanduser()
    if not path.is_file():
        raise FileNotFoundError(f"输入 xlsx 不存在: {path}")

    workbook = _load_workbook(path, data_only=True)
    try:
        if len(workbook.worksheets) < 3:
            raise ValueError("输入 workbook 少于 3 个 sheet")

        worksheet = workbook.worksheets[2]
        headers = [
            _clean_cell(worksheet.cell(row=1, column=index).value)
            for index in range(1, len(INPUT_HEADERS) + 1)
        ]
        _validate_input_headers(headers)
        column_indexes = {header: index + 1 for index, header in enumerate(INPUT_HEADERS)}

        rows: list[InvoiceSourceRow] = []
        for row_number in range(2, worksheet.max_row + 1):
            if not _clean_cell(worksheet.cell(row=row_number, column=column_indexes["日期"]).value):
                break
            rows.append(
                InvoiceSourceRow(
                    row_number=row_number,
                    sku=_clean_cell(worksheet.cell(row=row_number, column=column_indexes["SKU"]).value),
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
    finally:
        workbook.close()


def unique_source_skus(rows: list[InvoiceSourceRow]) -> list[str]:
    unique: OrderedDict[str, str] = OrderedDict()
    for row in rows:
        key = normalize_sku_key(row.sku)
        if not key or key in unique:
            continue
        unique[key] = row.sku
    return list(unique.values())


def translate_commodity_name(row: InvoiceSourceRow) -> str:
    name = row.commodity_name
    if "编织表带" in name:
        return "Braided Watch Band"
    if "表带" in name:
        return "Watch Band"
    if "表壳" in name:
        return "Watch Case"
    if "包装盒" in name:
        return "Packaging Box"
    if "手表保护套" in name:
        return "Watch Protective Case"
    return ""


def translated_material(material: str) -> str:
    material_text = _clean_cell(material)
    if not material_text:
        return ""
    english = MATERIAL_TRANSLATIONS.get(material_text)
    if not english:
        return ""
    return f"{material_text}/{english}"


def usage_for(row: InvoiceSourceRow) -> str:
    name = row.commodity_name
    if "表带" in name:
        return "装饰/decorate"
    if "表壳" in name:
        return "装饰/decorate"
    if "手表保护套" in name:
        return "保护手表用/Used for protecting watches"
    if "包装盒" in name:
        return "装表带表壳/Watch strap and case"
    return ""


def _quantity_decimal(row: InvoiceSourceRow) -> Decimal:
    text = _clean_cell(row.quantity)
    if not text:
        raise ValueError(f"第{row.row_number}行发货量不能为空")
    try:
        return Decimal(text)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"第{row.row_number}行发货量无法解析为数字: {row.quantity}") from exc


def _decimal_to_cell_value(value: Decimal) -> int | float | str:
    if value == value.to_integral_value():
        return int(value)
    text = format(value.normalize(), "f").rstrip("0").rstrip(".")
    try:
        return float(text)
    except ValueError:
        return text


def declared_price_for(row: InvoiceSourceRow, material: str) -> int | float | str:
    material_text = _clean_cell(material)
    unit_price: Decimal | None = None
    if "表带" in row.commodity_name:
        if material_text == "硅胶":
            unit_price = Decimal("0.35")
        elif material_text == "尼龙":
            unit_price = Decimal("0.5")
        elif material_text in {"金属", "贱金属"}:
            unit_price = Decimal("1")
    elif "表壳" in row.commodity_name:
        unit_price = Decimal("0.35")
    elif "包装盒" in row.commodity_name:
        unit_price = Decimal("0.32")
    elif "手表保护套" in row.commodity_name:
        unit_price = Decimal("0.35")
    if unit_price is not None:
        return _decimal_to_cell_value(_quantity_decimal(row) * unit_price)
    return UNKNOWN_DECLARED_PRICE_TEXT


def _find_invoice_template_header_row(worksheet: Any) -> int:
    expected = list(INVOICE_TEMPLATE_HEADERS)
    for row_index in range(1, worksheet.max_row + 1):
        actual = [
            _clean_cell(worksheet.cell(row=row_index, column=column_index).value)
            for column_index in range(1, len(expected) + 1)
        ]
        if actual == expected:
            return row_index
    raise ValueError(f"{INVOICE_TEMPLATE_SHEET} sheet 缺少表头: {expected}")


def _copy_row_style(worksheet: Any, *, source_row: int, target_row: int) -> None:
    if source_row == target_row:
        return
    worksheet.row_dimensions[target_row].height = worksheet.row_dimensions[source_row].height
    for column_index in range(1, len(INVOICE_TEMPLATE_HEADERS) + 1):
        source_cell = worksheet.cell(row=source_row, column=column_index)
        target_cell = worksheet.cell(row=target_row, column=column_index)
        if source_cell.has_style:
            target_cell._style = copy.copy(source_cell._style)
        if source_cell.number_format:
            target_cell.number_format = source_cell.number_format
        if source_cell.alignment:
            target_cell.alignment = copy.copy(source_cell.alignment)
        if source_cell.font:
            target_cell.font = copy.copy(source_cell.font)
        if source_cell.fill:
            target_cell.fill = copy.copy(source_cell.fill)
        if source_cell.border:
            target_cell.border = copy.copy(source_cell.border)


def _clear_data_rows(worksheet: Any, *, header_row: int) -> None:
    for row_index in range(header_row + 1, worksheet.max_row + 1):
        for column_index in range(1, len(INVOICE_TEMPLATE_HEADERS) + 1):
            worksheet.cell(row=row_index, column=column_index).value = None


def _image_bytes(image: Any) -> bytes:
    try:
        return image._data()
    except Exception as exc:
        raise RuntimeError(f"读取库存SKU图片失败: {exc}") from exc


def load_stock_sku_images(xlsx_paths: list[str] | tuple[str, ...]) -> dict[str, bytes]:
    images_by_key: dict[str, bytes] = {}
    for raw_path in xlsx_paths:
        source_path = Path(raw_path).expanduser()
        if not source_path.is_file():
            raise FileNotFoundError(f"找不到库存SKU导出xlsx: {source_path}")
        workbook = _load_workbook(source_path, data_only=True)
        try:
            worksheet = workbook.worksheets[0]
            headers = [_clean_cell(worksheet.cell(row=1, column=column_index).value) for column_index in range(1, worksheet.max_column + 1)]
            if STOCK_SKU_COLUMN not in headers:
                raise RuntimeError(f"库存SKU导出xlsx缺少列: {STOCK_SKU_COLUMN}")
            if STOCK_SKU_IMAGE_COLUMN not in headers:
                raise RuntimeError(f"库存SKU导出xlsx缺少列: {STOCK_SKU_IMAGE_COLUMN}")
            sku_col = headers.index(STOCK_SKU_COLUMN) + 1
            image_col = headers.index(STOCK_SKU_IMAGE_COLUMN) + 1
            for image in list(getattr(worksheet, "_images", []) or []):
                marker = getattr(getattr(image, "anchor", None), "_from", None)
                if marker is None:
                    continue
                image_row = int(marker.row) + 1
                image_column = int(marker.col) + 1
                if image_column != image_col:
                    continue
                sku = _clean_cell(worksheet.cell(row=image_row, column=sku_col).value)
                key = normalize_sku_key(sku)
                if key and key not in images_by_key:
                    images_by_key[key] = _image_bytes(image)
        finally:
            workbook.close()
    return images_by_key


def _add_image_to_cell(worksheet: Any, *, image_bytes: bytes, row: int, column: int) -> None:
    try:
        from openpyxl.drawing.image import Image
        from openpyxl.utils import get_column_letter
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 图片依赖，无法写入产品图片") from exc

    image = Image(BytesIO(image_bytes))
    if image.width and image.height:
        scale = min(IMAGE_MAX_WIDTH / image.width, IMAGE_MAX_HEIGHT / image.height, 1)
        image.width = int(image.width * scale)
        image.height = int(image.height * scale)
    worksheet.row_dimensions[row].height = max(float(worksheet.row_dimensions[row].height or 0), IMAGE_ROW_HEIGHT)
    column_letter = get_column_letter(column)
    worksheet.column_dimensions[column_letter].width = max(
        float(worksheet.column_dimensions[column_letter].width or 0),
        IMAGE_COLUMN_WIDTH,
    )
    worksheet.add_image(image, f"{column_letter}{row}")


def write_invoice_template(
    rows: list[InvoiceSourceRow],
    *,
    sp_no: str,
    destination_country: str,
    stock_sku_xlsx_paths: list[str],
    template_path: str | Path | None = None,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    source_template = Path(DEFAULT_TEMPLATE_PATH if template_path is None else template_path).expanduser()
    if not source_template.is_file():
        raise FileNotFoundError(f"找不到发票模板: {source_template}")
    target_dir = Path(DEFAULT_OUTPUT_DIR if output_dir is None else output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    output_path = target_dir / f"{sp_no}_invoice_Template.xlsx"

    workbook = _load_workbook(source_template)
    try:
        if INVOICE_TEMPLATE_SHEET not in workbook.sheetnames:
            raise ValueError(f"发票模板缺少 sheet: {INVOICE_TEMPLATE_SHEET}")
        worksheet = workbook[INVOICE_TEMPLATE_SHEET]
        header_row = _find_invoice_template_header_row(worksheet)
        first_data_row = header_row + 1
        header_to_col = {
            _clean_cell(worksheet.cell(row=header_row, column=column_index).value): column_index
            for column_index in range(1, len(INVOICE_TEMPLATE_HEADERS) + 1)
        }
        _clear_data_rows(worksheet, header_row=header_row)
        images_by_key = load_stock_sku_images(stock_sku_xlsx_paths)

        notice: list[str] = []
        image_matched_count = 0
        image_missing_count = 0
        for offset, row in enumerate(rows):
            target_row = first_data_row + offset
            _copy_row_style(worksheet, source_row=first_data_row, target_row=target_row)
            classification = classify_declaration(row.to_declaration_row())
            material = classification.declaration_element
            hs_code = classification.hs_code
            if not material or not hs_code:
                notice.append(f"第{row.row_number}行未匹配申报规则: SKU={row.sku}, 商品名称={row.commodity_name}, 品名={row.source_name}")
            english_name = translate_commodity_name(row)
            if not english_name:
                notice.append(f"第{row.row_number}行缺少英文品名规则: SKU={row.sku}, 商品名称={row.commodity_name}")
            declared_price = declared_price_for(row, material)
            if declared_price == UNKNOWN_DECLARED_PRICE_TEXT:
                notice.append(f"第{row.row_number}行没有该材质的计算价格方式: SKU={row.sku}, 产品材质={material or ''}")
            material_value = translated_material(material)
            if material and not material_value:
                notice.append(f"第{row.row_number}行缺少产品材质英文映射: SKU={row.sku}, 产品材质={material}")
            usage = usage_for(row)
            if not usage:
                notice.append(f"第{row.row_number}行缺少产品用途规则: SKU={row.sku}, 商品名称={row.commodity_name}")

            values = {
                "产品英文品名*": english_name,
                "产品中文品名*": row.commodity_name,
                "产品申报单价*": declared_price,
                "单箱产品申报数量*": row.quantity,
                "单位*": row.unit,
                "产品材质*": material_value,
                "产品海关编码*": hs_code,
                "产品用途*": usage,
                "产品品牌*": "无",
                "品牌类型*": "无",
                "产品型号*": row.sku,
            }
            for header, value in values.items():
                worksheet.cell(row=target_row, column=header_to_col[header], value=value)

            image_key = normalize_sku_key(row.sku)
            image_data = images_by_key.get(image_key)
            if image_data:
                _add_image_to_cell(
                    worksheet,
                    image_bytes=image_data,
                    row=target_row,
                    column=header_to_col["产品图片*"],
                )
                image_matched_count += 1
            else:
                image_missing_count += 1
                notice.append(f"第{row.row_number}行缺少产品图片: SKU={row.sku}")

        workbook.save(output_path)
    finally:
        workbook.close()

    return {
        "success": True,
        "sp_no": sp_no,
        "destination_country": destination_country,
        "output_xlsx": str(output_path),
        "row_count": len(rows),
        "stock_sku_xlsx_paths": list(stock_sku_xlsx_paths),
        "image_matched_count": image_matched_count,
        "image_missing_count": image_missing_count,
        "notice": notice,
        "source": SOURCE,
    }


async def fill_invoice_template(
    input_xlsx: str | Path,
    *,
    template_path: str | Path | None = None,
    output_dir: str | Path | None = None,
    stock_sku_output_dir: str | Path | None = None,
) -> dict[str, Any]:
    input_path = Path(input_xlsx).expanduser()
    sp_no = extract_sp_no_from_filename(input_path)
    destination_country = extract_destination_country_from_filename(input_path)
    rows = read_invoice_source_rows(input_path)
    skus = unique_source_skus(rows)
    stock_result = await export_stock_sku_names(
        skus,
        delivery_no=f"{sp_no}_invoice",
        output_dir=STOCK_SKU_OUTPUT_DIR if stock_sku_output_dir is None else stock_sku_output_dir,
    )
    stock_sku_xlsx_paths = list(getattr(stock_result, "xlsx_paths", []) or [])
    payload = write_invoice_template(
        rows,
        sp_no=sp_no,
        destination_country=destination_country,
        stock_sku_xlsx_paths=stock_sku_xlsx_paths,
        template_path=template_path,
        output_dir=output_dir,
    )
    payload["input_xlsx"] = str(input_path)
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.fill_invoice_template"
    )
    parser.add_argument("--input-xlsx", default="")
    return parser


async def _run_async(args: argparse.Namespace) -> dict[str, Any]:
    input_xlsx = str(getattr(args, "input_xlsx", "") or "").strip()
    if not input_xlsx:
        raise ValueError("input_xlsx 不能为空")
    return await fill_invoice_template(input_xlsx)


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    try:
        args = build_parser().parse_args(argv)
        payload = asyncio.run(_run_async(args))
    except Exception as exc:
        payload = {
            "success": False,
            "exception": _exception_text(exc),
        }
    finally:
        try:
            asyncio.run(close_all_network_clients())
        except Exception:
            pass

    _write_json(payload)
    return 0 if bool(payload.get("success")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
