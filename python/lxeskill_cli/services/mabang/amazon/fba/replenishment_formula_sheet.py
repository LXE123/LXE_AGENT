"""Editable, per-export shipping projection. The Python decisions remain snapshots."""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .replenishment_template import calculate_weighted_daily_sales

if TYPE_CHECKING:
    from .store_msku_replenishment import ReplenishmentRow

FINAL_SHIPPING_SHEET = "最终备货意见"
FORMULA_PARAMS_SHEET = "备货公式参数"
SOURCE_VALUE_COLUMNS = (
    "7天销量", "14天销量", "30天销量", "90天销量", "可售", "待入库", "预留",
    "计划入库", "在途", "待调仓", "调仓中",
)
STOCK_COLUMNS = ("可售", "待入库", "预留", "在途", "待调仓", "调仓中")
FINAL_SHIPPING_COLUMNS = (
    "MSKU", "ASIN", "本地SKU", "品名", "7天销量", "14天销量", "30天销量", "90天销量",
    "加权日销", "可售", "待入库", "预留", "计划入库", "在途", "待调仓", "调仓中",
    "FBA总库存（马帮）", "未发出货件总计", "深圳可用库存", "建议运输方式（生成时）",
    "空运补货天数", "海运补货天数", "空运建议量", "海运建议量", "单件重量(g)",
    "预计总重量(kg)", "备注",
)
PARAM_COLUMNS = (
    "记录标识", "7天权重", "14天权重", "30天权重", "海运最小件数", "生成时类型",
    "商品备注", "缺少未关联快照", "输入有效", "理论空运", "理论海运", "扣FBA后空运",
    "扣FBA后海运", "扣货件后空运", "扣货件后海运", "满足海运件数", "最终空运",
    "最终海运", "预计总重量", "试算备注",
)


@dataclass(frozen=True)
class ShippingFormulaInputs:
    values: dict[str, float]
    weights: tuple[float, float, float]
    minimum_sea_quantity: float


def source_number(value: Any, *, context: str) -> float:
    try:
        if value is None or isinstance(value, bool) or str(value).strip() == "":
            raise ValueError("值为空或不是数值")
        result = float(str(value).strip().replace(",", ""))
        if not math.isfinite(result) or result < 0:
            raise ValueError("数值必须有限且大于等于0")
        return result
    except (ValueError, TypeError) as exc:
        raise ValueError(f"备货公式输入无效: {context}, value={value!r}, error={exc}") from exc


def _number_text(number: float) -> str:
    return str(int(number)) if float(number).is_integer() else f"{number:.2f}"


def shipping_quantities(row: ReplenishmentRow) -> tuple[int, int, int]:
    """Final urgent-air, air (including companion air), and sea quantities."""
    quantity = row.replenish_quantity or 0
    if row.sheet_name not in {"空运（急发）", "空运", "海运"} or quantity <= 0:
        return 0, 0, 0
    if row.sheet_name == "海运":
        air = row.companion_air_quantity if row.companion_air_quantity is not None else 0
        sea = row.sea_quantity
        if sea is None or air < 0 or sea < 0 or air + sea != quantity:
            raise ValueError(
                f"最终发货数量拆分不一致: MSKU={row.msku}, "
                f"companion_air={air}, sea={sea}, total={quantity}"
            )
        return 0, air, sea
    return (quantity, 0, 0) if row.sheet_name == "空运（急发）" else (0, quantity, 0)


def _initial_values(row: ReplenishmentRow, missing_snapshot: bool) -> tuple[dict[str, Any], dict[str, Any]]:
    inputs = row.formula_inputs
    if inputs is None:
        raise ValueError(f"缺少备货公式源数据: MSKU={row.msku}，请重新生成同源销量分析报告")
    values = inputs.values
    # Keep the same evaluation order as the formal calculation and Excel's
    # left-associative formula. sum() can cross a ceil boundary on Python 3.12.
    daily = calculate_weighted_daily_sales(
        sales_7d=values["7天销量"], sales_14d=values["14天销量"], sales_30d=values["30天销量"],
        params={"weighted_sales": dict(zip(("7d_weight", "14d_weight", "30d_weight"), inputs.weights))},
    )
    fba = sum(values[key] for key in STOCK_COLUMNS)
    is_sea = row.sheet_name == "海运"
    air_days = (row.companion_air_days or 0) if is_sea else row.replenish_days
    sea_days = row.sea_days if is_sea else 0
    if air_days is None or sea_days is None:
        raise ValueError(f"缺少试算补货天数: MSKU={row.msku}")
    gross_air = math.ceil(daily * air_days)
    gross_sea = max(0, math.ceil(daily * sea_days) - gross_air) if is_sea else 0
    air_fba = max(0, math.ceil(gross_air - fba))
    sea_fba = max(0, math.ceil(gross_sea - max(0, fba - gross_air)))
    air_net = max(0, math.ceil(air_fba - row.unlinked_quantity))
    sea_net = max(0, math.ceil(sea_fba - max(0, row.unlinked_quantity - air_fba)))
    gate = not is_sea or sea_net >= inputs.minimum_sea_quantity
    air, sea = (air_net, sea_net) if gate else (0, 0)
    if air + sea != row.replenish_quantity:
        raise ValueError(f"试算初始值与正式计算不一致: MSKU={row.msku}, formula={air + sea}, calculated={row.replenish_quantity}")
    weight = (air + sea) * row.weight_grams / 1000 if row.weight_grams is not None and row.weight_grams > 0 else None
    notes = [row.remark] if row.remark else []
    notes.append(f"试算建议：空运{air}件，海运{sea}件")
    if row.actual_inventory is None:
        notes.append("深圳可用库存缺失或无效")
    elif air + sea > row.actual_inventory:
        notes.append(f"深圳库存不足，缺口{_number_text(air + sea - row.actual_inventory)}件")
    if weight is None:
        notes.append("单件重量缺失或无效，无法计算预计总重量")
    if missing_snapshot:
        notes.append("未取得同日未关联货件快照，需核实当前试算数量")
    public = {
        "A": row.msku, "B": row.asin, "C": row.local_sku, "D": row.local_sku_name or row.product_name,
        **dict(zip(("E", "F", "G", "H"), (values[k] for k in SOURCE_VALUE_COLUMNS[:4]))),
        "I": daily, **dict(zip(("J", "K", "L", "M", "N", "O", "P"), (values[k] for k in SOURCE_VALUE_COLUMNS[4:]))),
        "Q": fba, "R": row.unlinked_quantity, "S": row.actual_inventory,
        "T": "空运＋海运" if is_sea and air > 0 else row.sheet_name,
        "U": air_days, "V": sea_days, "W": air, "X": sea, "Y": row.weight_grams,
        "Z": weight, "AA": "；".join(notes),
    }
    params = dict(zip(("B", "C", "D"), inputs.weights))
    params.update({
        "E": inputs.minimum_sea_quantity, "F": "sea" if is_sea else "air", "G": row.remark,
        "H": int(missing_snapshot), "I": 1, "J": gross_air, "K": gross_sea,
        "L": air_fba, "M": sea_fba, "N": air_net, "O": sea_net, "P": int(gate),
        "Q": air, "R": sea, "S": weight, "T": public["AA"],
    })
    return public, params


def write_formula_sheet(workbook: Any, rows: list[ReplenishmentRow], *, missing_snapshot: bool) -> dict[str, dict[str, Any]]:
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation
    from openpyxl.worksheet.table import Table, TableStyleInfo

    order = {"空运（急发）": 0, "空运": 1, "海运": 2}
    selected = sorted(
        (r for r in rows if any(shipping_quantities(r))),
        key=lambda r: (order[r.sheet_name], -r.replenish_quantity, r.msku, r.asin),
    )
    sheet = workbook.create_sheet(FINAL_SHIPPING_SHEET, 0)
    helper = workbook.create_sheet(FORMULA_PARAMS_SHEET)
    helper.sheet_state = "hidden"
    helper.append(PARAM_COLUMNS)
    sheet.cell(1, 1, "浅黄色为可编辑输入，蓝色为公式。仅重算本表数量；运输方式固定，天数可手改。原明细为生成时快照，排序请使用表头筛选。")
    sheet.append([*FINAL_SHIPPING_COLUMNS, "记录标识"])
    caches: dict[str, dict[str, Any]] = {FINAL_SHIPPING_SHEET: {}, FORMULA_PARAMS_SHEET: {}}
    end, helper_end = len(selected) + 2, len(selected) + 1
    for h, row in enumerate(selected, 2):
        r = h + 1
        public, params = _initial_values(row, missing_snapshot)
        key = f"record-{h}"
        public["AB"], params["A"] = key, key
        for target, values, index in ((sheet, public, r), (helper, params, h)):
            for column, value in values.items():
                cell = target[f"{column}{index}"]
                cell.value = value
                if isinstance(value, str):
                    cell.data_type = "s"

        def p(column: str) -> str:
            return f"INDEX('{FORMULA_PARAMS_SHEET}'!${column}$2:${column}${helper_end},MATCH($AB{r},'{FORMULA_PARAMS_SHEET}'!$A$2:$A${helper_end},0))"

        def s(column: str) -> str:
            return f"INDEX('{FINAL_SHIPPING_SHEET}'!${column}$3:${column}${end},MATCH($A{h},'{FINAL_SHIPPING_SHEET}'!$AB$3:$AB${end},0))"

        visible_formulas = {
            "I": f'IFERROR(IF(AND(COUNT(E{r}:G{r})=3,MIN(E{r}:G{r})>=0),E{r}/7*{p("B")}+F{r}/14*{p("C")}+G{r}/30*{p("D")},""),"")',
            "Q": f'IFERROR(IF(AND(COUNT(J{r}:L{r},N{r}:P{r})=6,MIN(J{r}:L{r},N{r}:P{r})>=0),SUM(J{r}:L{r},N{r}:P{r}),""),"")',
            **{column: p(param) for column, param in (("W", "Q"), ("X", "R"), ("Z", "S"), ("AA", "T"))},
        }
        required = [s(c) for c in ("E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "U", "V")]
        args = ",".join(required)
        total = f"(Q{h}+R{h})"
        shortage = f"({total}-{s('S')})"
        shortage_text = f'IF(INT({shortage})={shortage},TEXT({shortage},"0"),TEXT({shortage},"0.00"))'
        helper_formulas = {
            "I": f'IFERROR(IF(AND(COUNT({args})=16,MIN({args})>=0,{s("U")}=INT({s("U")}),{s("V")}=INT({s("V")}),IF(F{h}="sea",{s("V")}>0,{s("U")}>0)),1,0),0)',
            "J": f'IF(I{h}=1,ROUNDUP({s("I")}*{s("U")},0),0)',
            "K": f'IF(AND(I{h}=1,F{h}="sea"),MAX(0,ROUNDUP({s("I")}*{s("V")},0)-J{h}),0)',
            "L": f'IF(I{h}=1,MAX(0,ROUNDUP(J{h}-{s("Q")},0)),0)',
            "M": f'IF(I{h}=1,MAX(0,ROUNDUP(K{h}-MAX(0,{s("Q")}-J{h}),0)),0)',
            "N": f'IF(I{h}=1,MAX(0,ROUNDUP(L{h}-{s("R")},0)),0)',
            "O": f'IF(I{h}=1,MAX(0,ROUNDUP(M{h}-MAX(0,{s("R")}-L{h}),0)),0)',
            "P": f'IF(AND(F{h}="sea",O{h}<E{h}),0,1)',
            "Q": f'IF(I{h}=1,IF(P{h}=1,N{h},0),"")',
            "R": f'IF(I{h}=1,IF(P{h}=1,O{h},0),"")',
            "S": f'IFERROR(IF(AND(I{h}=1,ISNUMBER({s("Y")}),{s("Y")}>0),{total}*{s("Y")}/1000,""),"")',
            "T": (
                f'G{h}&IF(G{h}="","","；")&IF(I{h}=0,"输入无效：销量、库存、货件须为非负数，补货天数须为有效整数",'
                f'"试算建议：空运"&TEXT(Q{h},"0")&"件，海运"&TEXT(R{h},"0")&"件"'
                f'&IF(P{h}=0,"；海运数量不足"&TEXT(E{h},"0.##")&"件","")'
                f'&IF({total}=0,"；当前建议量为0","")'
                f'&IF(IFERROR(AND(COUNTBLANK({s("S")})=0,ISNUMBER({s("S")}),{s("S")}>={0}),FALSE),'
                f'IF({total}>{s("S")},"；深圳库存不足，缺口"&{shortage_text}&"件",""),"；深圳可用库存缺失或无效")'
                f'&IF(S{h}="","；单件重量缺失或无效，无法计算预计总重量",""))'
                f'&IF(H{h}=1,"；未取得同日未关联货件快照，需核实当前试算数量","")'
            ),
        }
        for target, formulas, initial, index in ((sheet, visible_formulas, public, r), (helper, helper_formulas, params, h)):
            for column, formula in formulas.items():
                address = f"{column}{index}"
                target[address] = "=" + formula
                caches[target.title][address] = initial[column]

    sheet.freeze_panes = "E3"
    sheet.sheet_view.showGridLines = False
    sheet.column_dimensions["AB"].hidden = True
    if selected:
        # Excel rejects a worksheet filter overlapping a Table's own filter.
        table = Table(displayName="FinalShipping", ref=f"A2:AB{end}")
        table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=False)
        sheet.add_table(table)
        numeric = DataValidation(type="decimal", operator="greaterThanOrEqual", formula1=0, allow_blank=False)
        numeric.showErrorMessage = True
        numeric.error = "请输入大于等于0的数值；不要清空必需输入。"
        sheet.add_data_validation(numeric)
        for column in ("E", "F", "G", "H", "J", "K", "L", "M", "N", "O", "P", "R", "S", "Y"):
            numeric.add(f"{column}3:{column}{end}")
        days = DataValidation(type="whole", operator="greaterThanOrEqual", formula1=0, allow_blank=False)
        days.showErrorMessage = True
        days.error = "请输入大于等于0的整数；0表示不适用。"
        sheet.add_data_validation(days)
        days.add(f"U3:V{end}")
    else:
        sheet.auto_filter.ref = "A2:AB2"
    widths = (32, 16, 28, 35, 13, 13, 13, 13, 14, 12, 12, 12, 13, 12, 13, 13, 22, 22, 18, 24, 18, 18, 17, 17, 18, 22, 66)
    input_columns = {5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 22, 25}
    formula_columns = {9, 17, 23, 24, 26, 27}
    for index, width in enumerate(widths, 1):
        sheet.column_dimensions[get_column_letter(index)].width = width
        header = sheet.cell(2, index)
        header.fill = PatternFill("solid", fgColor="243746")
        header.font = Font(bold=True, color="FFFFFF")
        header.alignment = Alignment(vertical="center", wrap_text=True)
    sheet.row_dimensions[1].height = 26
    sheet.row_dimensions[2].height = 34
    for cells in sheet.iter_rows(min_row=3, max_row=end, max_col=27):
        sheet.row_dimensions[cells[0].row].height = 66
        for index, cell in enumerate(cells, 1):
            cell.alignment = Alignment(vertical="center", wrap_text=True)
            if index in input_columns | formula_columns:
                cell.fill = PatternFill("solid", fgColor="FFF2CC" if index in input_columns else "EAF2F8")
            if index in (9, 25, 26):
                cell.number_format = "#,##0.00"
            elif 5 <= index <= 24 and index != 20:
                cell.number_format = "#,##0.00" if isinstance(cell.value, float) and not cell.value.is_integer() else "#,##0"
    workbook.active = 0
    return caches


def cache_formula_values(path: Path, caches: dict[str, dict[str, Any]]) -> None:
    """Insert initial OOXML cached values after openpyxl's final metadata save."""
    import os
    import posixpath
    from .report_staging import staged_report_path
    from xml.etree import ElementTree as ET
    from zipfile import ZipFile

    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    relns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    # Preserve the default worksheet namespace used by the original Excel package.
    ET.register_namespace("", ns)
    ET.register_namespace("r", relns)
    with staged_report_path(path) as temporary_path:
        with ZipFile(path) as source:
            relationships = {r.attrib["Id"]: r.attrib["Target"] for r in ET.fromstring(source.read("xl/_rels/workbook.xml.rels"))}
            sheets = ET.fromstring(source.read("xl/workbook.xml")).find(f"{{{ns}}}sheets")
            replacements = {}
            for sheet in sheets:
                values = caches.get(sheet.attrib["name"])
                if not values:
                    continue
                target = relationships[sheet.attrib[f"{{{relns}}}id"]]
                filename = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
                tree = ET.fromstring(source.read(filename))
                found = set()
                for cell in tree.iter(f"{{{ns}}}c"):
                    address = cell.attrib["r"]
                    if address not in values:
                        continue
                    if cell.find(f"{{{ns}}}f") is None:
                        raise ValueError(f"公式缓存目标不是公式: {sheet.attrib['name']}!{address}")
                    value = values[address]
                    if value is None or isinstance(value, str):
                        cell.attrib["t"] = "str"
                    else:
                        cell.attrib.pop("t", None)
                    cached = cell.find(f"{{{ns}}}v")
                    if cached is None:
                        cached = ET.SubElement(cell, f"{{{ns}}}v")
                    cached.text = "" if value is None else str(value)
                    found.add(address)
                if found != set(values):
                    raise ValueError(f"公式缓存目标缺失: {set(values) - found}")
                replacements[filename] = ET.tostring(tree, encoding="utf-8", xml_declaration=True)
            with ZipFile(temporary_path, "w") as output:
                for info in source.infolist():
                    data = replacements[info.filename] if info.filename in replacements else source.read(info.filename)
                    output.writestr(info, data)
        # Windows rejects replacement while the source ZIP is still open.
        os.replace(temporary_path, path)
