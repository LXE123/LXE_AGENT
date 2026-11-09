from contextlib import contextmanager
from datetime import date
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.styles import PatternFill


TODAY = date(2026, 11, 5)
TEMPLATE = Path(__file__).resolve().parents[2] / "services/mabang/order_import/resources/template.xlsx"
LAYOUTS = {
    "brazil": ("巴西", 6, {**dict.fromkeys(range(46, 57), "10/1海运"), 56: "11/6海运"},
               {56: [10, None, 30]}),
    "malaysia": ("马来西亚", 5, {2: "11/4A海运", 7: "11/4B海运", 8: "11/4空运", 44: "10/30空运"},
                 {2: [7, 0, None], 7: [0, None, 9], 8: [5, None, 3]}),
    "vietnam": ("越南备货清单", 5, {41: "11/4陆运", 43: "10/30海运"},
                {41: [5, 0, None], 43: [3, 4, None]}),
    "philippines": ("菲律宾备货清单", 5, {
        40: "11/2空运", 41: "11/5空运", 49: "11/1A海运", 50: "10/20B海运",
        51: "11/4A海运", 52: "11/7B海运",
    }, {41: [10, 0, None], 51: [None, 8, 0], 52: [3, None, 4]}),
    "indonesia": ("印尼", 5, {
        53: "11/3空运", 54: "11/6空运", 55: "10/15A海运", 56: "10/15B海运",
        57: "10/22海运", 58: "11/4海运", 59: "11/6海运",
    }, {54: [10, 0, None], 55: [20, None, None], 56: [None, 22, None], 59: [0, 8, 4]}),
}


def source_workbook(path, country="vietnam", changes=None, sheet_name=None):
    name, sku_column, headers, quantities = LAYOUTS[country]
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = sheet_name or name
    sheet.cell(1, sku_column, "SKU")
    for column, header in headers.items():
        sheet.cell(1, column, header)
    for row, sku in enumerate(["SKU-A", "SKU-B", "SKU-A"], 2):
        sheet.cell(row, sku_column, sku)
        for column, values in quantities.items():
            sheet.cell(row, column, values[row - 2])
    sheet.cell(5, next(iter(quantities)), 99)  # No SKU: this row must be skipped.
    if country in {"brazil", "malaysia"}:
        unused = 46 if country == "brazil" else 44
        sheet.cell(1, unused).fill = PatternFill(fill_type="solid", fgColor="FFFFFF00")
        sheet.cell(2, unused, "=1+1")
    if country == "malaysia":
        sheet["F2"] = 999  # A wrong negative index must not masquerade as B2=7.
    for coordinate, value in (changes or {}).items():
        sheet[coordinate] = value
    workbook.save(path)
    workbook.close()
    return path


@contextmanager
def open_sheet(path):
    workbook = load_workbook(path)
    try:
        yield workbook.active
    finally:
        workbook.close()


def rows(sheet):
    return [(sheet.cell(r, 4).value, sheet.cell(r, 19).value, sheet.cell(r, 20).value)
            for r in range(2, sheet.max_row + 1)]
