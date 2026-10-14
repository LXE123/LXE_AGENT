"""Place validated current results into the user's nine-sheet business workbook.

The four operational worksheets are copied as OOXML parts, so their cells,
cached values, formatting, and shared-formula definitions are untouched.
"""

from __future__ import annotations

from contextlib import contextmanager
from copy import copy
import os
from pathlib import Path
import posixpath
from xml.dom import minidom
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile

from openpyxl import load_workbook


MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT = "http://schemas.openxmlformats.org/package/2006/content-types"
REQUIRED_ORDER = (
    "越南备货清单", "改库存", "改折扣", "报官方活动", "竞价报名",
    "雅仓库存", "雅仓动销", "数据更改", "库存商品信息",
)
UNCHANGED = REQUIRED_ORDER[1:5]
CURRENT = (REQUIRED_ORDER[0], *REQUIRED_ORDER[5:])


class FullWorkbookError(ValueError):
    """The supplied business workbook cannot safely preserve all nine tabs."""


def validate_full_template(path: str | Path) -> None:
    """Check that a stored template can supply inputs and preserve four tabs."""
    source = Path(path)
    if source.suffix.lower() != ".xlsx" or not source.is_file():
        raise FullWorkbookError(f"越南备货模板必须是现有的 .xlsx 文件: {source}")
    if source.stat().st_size > 40 * 1024 * 1024:
        raise FullWorkbookError("越南备货模板超过 40 MiB")
    try:
        with ZipFile(source) as archive:
            items = archive.infolist()
            if len(items) > 2000 or sum(item.file_size for item in items) > 250 * 1024 * 1024:
                raise FullWorkbookError("越南备货模板 ZIP 内容超过限制")
            if any(item.flag_bits & 1 for item in items):
                raise FullWorkbookError("越南备货模板包含加密内容")
            if archive.testzip() is not None:
                raise FullWorkbookError("越南备货模板 ZIP 内容损坏")
            parts = _sheet_parts(archive)
            if tuple(parts) != REQUIRED_ORDER:
                raise FullWorkbookError("越南备货模板须包含指定顺序的九张工作表")
            sheets = ET.fromstring(archive.read("xl/workbook.xml")).find(f"{{{MAIN}}}sheets")
            if any(sheet.attrib.get("state", "visible") != "visible" for sheet in sheets):
                raise FullWorkbookError("越南备货模板的九张工作表都必须可见")
            if any(f"xl/worksheets/_rels/{Path(parts[name]).name}.rels" in archive.namelist() for name in UNCHANGED):
                raise FullWorkbookError("越南备货模板的四张业务表含独立附件关系，无法原样保留")
        workbook = load_workbook(source, read_only=True, data_only=False)
        try:
            first = next(workbook[REQUIRED_ORDER[0]].iter_rows(min_row=1, max_row=1, max_col=36))
            for column, label in ((2, "判断热销"), (5, "SKU"), (7, "成本"),
                                  (31, "跨境价"), (36, "折扣价")):
                if first[column - 1].value != label:
                    raise FullWorkbookError(f"越南备货清单第 {column} 列表头应为 {label}")
        finally:
            workbook.close()
    except FullWorkbookError:
        raise
    except (BadZipFile, KeyError, ET.ParseError, OSError, ValueError, StopIteration) as exc:
        raise FullWorkbookError(f"读取越南备货模板失败: {type(exc).__name__}: {exc}") from exc


@contextmanager
def _parsed(data: bytes):
    document = minidom.parseString(data)
    try:
        yield document
    finally:
        document.unlink()


def _sheet_parts(archive: ZipFile) -> dict[str, str]:
    relationships = {
        item.attrib["Id"]: item.attrib["Target"]
        for item in ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    }
    sheets = ET.fromstring(archive.read("xl/workbook.xml")).find(f"{{{MAIN}}}sheets")
    if sheets is None:
        raise FullWorkbookError("业务模板缺少工作表列表")
    parts = {}
    for sheet in sheets:
        target = relationships[sheet.attrib[f"{{{REL}}}id"]]
        part = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
        if not part.startswith("xl/worksheets/") or part not in archive.namelist():
            raise FullWorkbookError(f"工作表 {sheet.attrib['name']} 的文件无效")
        parts[sheet.attrib["name"]] = part
    return parts


def _elements(node):
    return [child for child in node.childNodes if child.nodeType == child.ELEMENT_NODE]


def _section(document, name: str):
    found = document.getElementsByTagNameNS(MAIN, name)
    return found[0] if found else None


def _append_styles(template: ZipFile, calculated: ZipFile) -> tuple[bytes, dict[str, int]]:
    """Append new style indices; source style indices used by unchanged tabs stay stable."""
    with _parsed(template.read("xl/styles.xml")) as original, _parsed(calculated.read("xl/styles.xml")) as fresh:
        offsets = {}
        for name in ("fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "dxfs"):
            old = _section(original, name)
            new = _section(fresh, name)
            if name == "dxfs" and old is None and new is not None:
                old = original.createElementNS(MAIN, "dxfs")
                old.setAttribute("count", "0")
                original.documentElement.insertBefore(old, _section(original, "tableStyles"))
            if old is None or new is None:
                if name == "dxfs" and new is None:
                    offsets[name] = 0
                    continue
                raise FullWorkbookError(f"样式表缺少 {name}")
            offsets[name] = len(_elements(old))

        original_formats = _section(original, "numFmts")
        fresh_formats = _section(fresh, "numFmts")
        used_ids = {int(node.getAttribute("numFmtId")) for node in _elements(original_formats)} if original_formats else set()
        next_id = max(used_ids | {163}) + 1
        number_formats = {}
        if fresh_formats is not None:
            if original_formats is None:
                raise FullWorkbookError("业务模板缺少自定义数字格式表")
            for node in _elements(fresh_formats):
                old_id = int(node.getAttribute("numFmtId"))
                if old_id <= 163:
                    number_formats[old_id] = old_id
                    continue
                number_formats[old_id] = next_id
                copied = original.importNode(node, deep=True)
                copied.setAttribute("numFmtId", str(next_id))
                original_formats.appendChild(copied)
                next_id += 1
            original_formats.setAttribute("count", str(len(_elements(original_formats))))

        for name in ("fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "dxfs"):
            old = _section(original, name)
            new = _section(fresh, name)
            if new is None:
                continue
            for node in _elements(new):
                copied = original.importNode(node, deep=True)
                for attr, target in (("fontId", "fonts"), ("fillId", "fills"), ("borderId", "borders")):
                    if copied.hasAttribute(attr):
                        copied.setAttribute(attr, str(int(copied.getAttribute(attr)) + offsets[target]))
                if copied.hasAttribute("numFmtId"):
                    number = int(copied.getAttribute("numFmtId"))
                    copied.setAttribute("numFmtId", str(number_formats.get(number, number)))
                if copied.hasAttribute("xfId"):
                    copied.setAttribute("xfId", str(int(copied.getAttribute("xfId")) + offsets["cellStyleXfs"]))
                old.appendChild(copied)
            old.setAttribute("count", str(len(_elements(old))))
        return original.toxml(encoding="utf-8"), offsets


def _append_strings(template: ZipFile, calculated: ZipFile) -> tuple[bytes | None, int, bool]:
    old_bytes = template.read("xl/sharedStrings.xml") if "xl/sharedStrings.xml" in template.namelist() else None
    new_bytes = calculated.read("xl/sharedStrings.xml") if "xl/sharedStrings.xml" in calculated.namelist() else None
    if not new_bytes:
        return old_bytes, 0, False
    if not old_bytes:
        return new_bytes, 0, True
    with _parsed(old_bytes) as original, _parsed(new_bytes) as fresh:
        root = original.documentElement
        offset = len(_elements(root))
        for item in _elements(fresh.documentElement):
            root.appendChild(original.importNode(item, deep=True))
        root.setAttribute("uniqueCount", str(len(_elements(root))))
        root.setAttribute("count", str(len(_elements(root))))
        return original.toxml(encoding="utf-8"), offset, False


def _string_part_declarations(template: ZipFile) -> dict[str, bytes]:
    """Add the standard package references when an inline-string template needs an SST."""
    with _parsed(template.read("[Content_Types].xml")) as types:
        item = types.createElementNS(CONTENT, "Override")
        item.setAttribute("PartName", "/xl/sharedStrings.xml")
        item.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml")
        types.documentElement.appendChild(item)
        content_types = types.toxml(encoding="utf-8")
    with _parsed(template.read("xl/_rels/workbook.xml.rels")) as relations:
        existing = {node.getAttribute("Id") for node in relations.getElementsByTagNameNS(PACKAGE_REL, "Relationship")}
        identifier = "rIdLxeSharedStrings"
        if identifier in existing:
            raise FullWorkbookError("工作簿关系 ID 与共享字符串表冲突")
        item = relations.createElementNS(PACKAGE_REL, "Relationship")
        item.setAttribute("Id", identifier)
        item.setAttribute("Type", REL + "/sharedStrings")
        item.setAttribute("Target", "sharedStrings.xml")
        relations.documentElement.appendChild(item)
        workbook_rels = relations.toxml(encoding="utf-8")
    return {"[Content_Types].xml": content_types, "xl/_rels/workbook.xml.rels": workbook_rels}


def _current_sheet(data: bytes, style_offset: int, string_offset: int, dxf_offset: int) -> bytes:
    with _parsed(data) as sheet:
        for tag, attr in (("c", "s"), ("row", "s"), ("col", "style")):
            for item in sheet.getElementsByTagNameNS(MAIN, tag):
                if item.hasAttribute(attr):
                    item.setAttribute(attr, str(int(item.getAttribute(attr)) + style_offset))
                if tag == "c" and item.getAttribute("t") == "s":
                    values = item.getElementsByTagNameNS(MAIN, "v")
                    if len(values) != 1 or not values[0].firstChild:
                        raise FullWorkbookError("重算工作表的共享字符串索引无效")
                    values[0].firstChild.data = str(int(values[0].firstChild.data) + string_offset)
        for item in sheet.getElementsByTagNameNS(MAIN, "cfRule"):
            if item.hasAttribute("dxfId"):
                item.setAttribute("dxfId", str(int(item.getAttribute("dxfId")) + dxf_offset))
        return sheet.toxml(encoding="utf-8")


def _workbook_xml(data: bytes, row_count: int) -> bytes:
    with _parsed(data) as workbook:
        for name in workbook.getElementsByTagNameNS(MAIN, "definedName"):
            if name.getAttribute("name") == "_xlnm._FilterDatabase" and name.getAttribute("localSheetId") == "0":
                if name.firstChild:
                    name.firstChild.data = f"越南备货清单!$A$1:$AY${row_count}"
        calc = workbook.getElementsByTagNameNS(MAIN, "calcPr")
        if calc:
            calc[0].setAttribute("calcMode", "auto")
            calc[0].setAttribute("fullCalcOnLoad", "1")
        return workbook.toxml(encoding="utf-8")


def combine_full_workbook(template_path: str | Path, current_path: str | Path, output_path: str | Path) -> None:
    """Keep four original worksheet parts byte-for-byte and replace the five calculated parts."""
    destination = Path(output_path)
    if os.path.lexists(destination):
        raise FileExistsError(destination)
    try:
        with ZipFile(template_path) as template, ZipFile(current_path) as current:
            source_parts = _sheet_parts(template)
            result_parts = _sheet_parts(current)
            if tuple(source_parts) != REQUIRED_ORDER or tuple(result_parts) != CURRENT:
                raise FullWorkbookError("业务模板须为指定顺序的九表，重算结果须为五表")
            template_sheets = ET.fromstring(template.read("xl/workbook.xml")).find(f"{{{MAIN}}}sheets")
            if any(sheet.attrib.get("state", "visible") != "visible" for sheet in template_sheets):
                raise FullWorkbookError("业务模板的九张工作表都必须可见")
            if any(f"xl/worksheets/_rels/{Path(source_parts[name]).name}.rels" in template.namelist() for name in UNCHANGED):
                raise FullWorkbookError("待保留的四张表包含独立附件关系，当前无法原样保留")
            styles, offsets = _append_styles(template, current)
            strings, string_offset, new_strings = _append_strings(template, current)
            replacements = {"xl/styles.xml": styles}
            if strings is not None:
                replacements["xl/sharedStrings.xml"] = strings
            if new_strings:
                replacements.update(_string_part_declarations(template))
            for name in CURRENT:
                replacements[source_parts[name]] = _current_sheet(
                    current.read(result_parts[name]), offsets["cellXfs"], string_offset, offsets["dxfs"]
                )
            first = ET.fromstring(current.read(result_parts[CURRENT[0]]))
            dimension = first.find(f"{{{MAIN}}}dimension")
            row_count = int((dimension.attrib["ref"] if dimension is not None else "A1").split(":")[-1].lstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
            replacements["xl/workbook.xml"] = _workbook_xml(template.read("xl/workbook.xml"), row_count)
            destination.parent.mkdir(parents=True, exist_ok=True)
            created = False
            try:
                with destination.open("xb") as handle:
                    created = True
                    with ZipFile(handle, "w") as output:
                        output.comment = template.comment
                        for item in template.infolist():
                            if item.is_dir():
                                continue
                            data = replacements.get(item.filename)
                            output.writestr(copy(item), data if data is not None else template.read(item.filename))
                        if new_strings:
                            output.writestr("xl/sharedStrings.xml", strings)
                with ZipFile(destination) as published:
                    if published.testzip() is not None or tuple(_sheet_parts(published)) != REQUIRED_ORDER:
                        raise FullWorkbookError("九表成品文件校验失败")
                    if any(published.read(source_parts[name]) != template.read(source_parts[name]) for name in UNCHANGED):
                        raise FullWorkbookError("九表成品中的原始业务表发生改变")
            except BaseException:
                if created:
                    destination.unlink(missing_ok=True)
                raise
    except (KeyError, ET.ParseError, ValueError) as exc:
        if isinstance(exc, FullWorkbookError):
            raise
        raise FullWorkbookError(f"读取或合并九表模板失败: {type(exc).__name__}: {exc}") from exc


__all__ = ["CURRENT", "REQUIRED_ORDER", "UNCHANGED", "FullWorkbookError", "combine_full_workbook", "validate_full_template"]
