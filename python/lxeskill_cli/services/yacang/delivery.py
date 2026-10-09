"""Publish the validated sales report without its trailing snapshot date."""
from __future__ import annotations

from pathlib import Path
import re
from xml.dom import minidom
from zipfile import ZipFile

from shared.filesystem import filesystem_path
from .errors import YacangError


SPREADSHEET_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def publish_inventory_sales_without_snapshot_date(original: Path, temporary: Path, target: Path) -> None:
    """Edit only worksheet XML; the caller has validated the original headers."""
    with filesystem_path(original).open("rb") as source, ZipFile(source) as package:
        sheets = [name for name in package.namelist() if name.startswith("xl/worksheets/") and name.endswith(".xml")]
        if len(sheets) != 1:
            raise YacangError("处理库存动销 XLSX", f"工作表 XML 数量异常: {len(sheets)}")
        sheet_name = sheets[0]
        # DOM retains declarations used by mc:Ignorable and other prefix-valued
        # attributes; rebuilding the worksheet can drop them or shared strings.
        with minidom.parseString(package.read(sheet_name)) as document:
            dimensions = document.getElementsByTagNameNS(SPREADSHEET_NAMESPACE, "dimension")
            if len(dimensions) != 1 or not re.fullmatch(r"A1:P[1-9][0-9]*", dimensions[0].getAttribute("ref")):
                raise YacangError("处理库存动销 XLSX", "原始报表列范围不是预期的 A1:P")
            dimension = dimensions[0]
            dimension.setAttribute("ref", dimension.getAttribute("ref").replace(":P", ":O", 1))
            removed_header = False
            for row in document.getElementsByTagNameNS(SPREADSHEET_NAMESPACE, "row"):
                for cell in list(row.childNodes):
                    if cell.namespaceURI != SPREADSHEET_NAMESPACE or cell.localName != "c":
                        continue
                    if cell.getAttribute("r") == f"P{row.getAttribute('r')}":
                        removed_header |= cell.getAttribute("r") == "P1"
                        row.removeChild(cell)
                        cell.unlink()
                if row.getAttribute("spans") == "1:16":
                    row.setAttribute("spans", "1:15")
            if not removed_header:
                raise YacangError("处理库存动销 XLSX", "原始报表缺少创建日期表头单元格")
            modified_sheet = document.toxml(encoding="utf-8")
        with filesystem_path(temporary).open("xb") as output, ZipFile(output, "w") as published:
            published.comment = package.comment
            for member in package.infolist():
                published.writestr(member, modified_sheet if member.filename == sheet_name else package.read(member.filename))
    filesystem_path(temporary).replace(filesystem_path(target))
