"""Export one original Shangman ERP workbook using the existing persisted login."""
from __future__ import annotations

import asyncio
from collections import Counter
from datetime import datetime
import json
import posixpath
from pathlib import Path
import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4
from xml.etree import ElementTree
from zipfile import ZIP_DEFLATED, ZipFile
from zoneinfo import ZoneInfo

import aiohttp
from openpyxl import load_workbook
from openpyxl.utils.cell import column_index_from_string, get_column_letter

from shared.datasets import dataset_dir
from .auth import BASE_URL, AuthError, Credentials
from .state import AuthStore

EXPORT_PATH = "/api/blade-goods/goods/merchant/exportNew"
LIST_PATH = "/api/blade-goods/goods/merchant/list"
LIST_PAGE_SIZE = 500
DOWNLOAD_HOSTS = frozenset({"erp.shangmanet.com", "oss.erp.shangmanet.com"})
REQUIRED_HEADERS = frozenset({
    "SKU", "商品名", "总数量", "有效库存", "锁定库存", "在途库存", "预警库存",
    "7天销量", "15天销量", "30天销量", "仓库名称", "创建时间",
})
_URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+")
_JSON_LIMIT = 2 * 1024 * 1024


def _safe_urls(message: str) -> str:
    def clean(match: re.Match) -> str:
        try:
            parsed = urlsplit(match.group())
            return urlunsplit((parsed.scheme, parsed.hostname or "", parsed.path,
                               "[redacted]" if parsed.query else "", ""))
        except ValueError:
            return "[redacted URL]"
    return _URL_PATTERN.sub(clean, message)


def _header(value: Any) -> str:
    compact = re.sub(r"\s+", "", str(value or ""))
    translated = re.search(r"\(([^()]*)\)$", compact)
    label = translated.group(1) if translated else compact
    return {"商品编码": "SKU", "商品名称": "商品名"}.get(label, label)


def validate_workbook(path: Path) -> dict[str, Any]:
    try:
        workbook = load_workbook(path, read_only=True, data_only=True)
    except Exception as exc:
        raise AuthError("invalid_workbook", f"下载文件不是可读取的 XLSX: {type(exc).__name__}: {exc}") from exc
    try:
        observed = []
        for sheet in workbook.worksheets:
            # Some platform exports incorrectly declare only A1 in <dimension>.
            sheet.reset_dimensions()
            found = False
            count = 0
            headers = []
            for row in sheet.iter_rows(values_only=True):
                if not found:
                    normalized = {_header(value) for value in row}
                    if REQUIRED_HEADERS.issubset(normalized):
                        found = True
                        headers = [str(value).strip() if value is not None else "" for value in row]
                    elif len(observed) < 5:
                        observed.append([str(value)[:100] for value in row[:40] if value is not None])
                elif any(value not in (None, "") for value in row):
                    count += 1
            if found:
                return {"sheet_names": workbook.sheetnames, "data_sheet": sheet.title,
                        "row_count": count, "headers": headers}
        raise AuthError("invalid_workbook", f"下载工作簿缺少必需业务表头；读取到的前几行: {observed}")
    finally:
        workbook.close()


def _text_key(value: Any, *, field: str) -> str:
    if not isinstance(value, str):
        raise AuthError("identity_mapping_failed", f"启用商品或官方表格的{field}不是文本")
    if not value or not value.strip():
        raise AuthError("identity_mapping_failed", f"启用商品或官方表格缺少{field}")
    return value


def _time_key(value: Any) -> str:
    if not isinstance(value, str):
        raise AuthError("identity_mapping_failed", "启用商品或官方表格的创建时间不是文本")
    if not value or not value.strip():
        raise AuthError("identity_mapping_failed", "启用商品或官方表格缺少创建时间")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise AuthError("identity_mapping_failed", f"无法解析商品创建时间 {value!r}: {exc}") from exc
    return value


def _record_key(record: dict[str, Any]) -> tuple[str, str]:
    goods_no = _text_key(record.get("goodsNo"), field="商品编码")
    goods_sku = _text_key(record.get("goodsSku"), field="SKU")
    if goods_no != goods_sku:
        raise AuthError("identity_mapping_failed", "启用列表中 goodsNo 与 goodsSku 不一致，无法可靠关联官方表格")
    return goods_no, _time_key(record.get("createTime"))


def _workbook_identity_columns(path: Path) -> tuple[str, int, int, int]:
    workbook = load_workbook(path, read_only=True, data_only=False)
    try:
        candidates = []
        for sheet in workbook.worksheets:
            sheet.reset_dimensions()
            for row_number, row in enumerate(sheet.iter_rows(values_only=True), start=1):
                normalized = [_header(value) for value in row]
                code_column = next((i for i, value in enumerate(normalized) if value == "SKU"), None)
                time_column = next((i for i, value in enumerate(normalized) if value == "创建时间"), None)
                if code_column is not None and time_column is not None:
                    candidates.append((sheet.title, row_number, code_column, time_column))
                    break
        if not candidates:
            raise AuthError("identity_mapping_failed", "官方工作簿缺少 SKU/商品编码 或 创建时间 表头")
        if len(candidates) != 1:
            raise AuthError("identity_mapping_failed", "官方工作簿包含多个商品数据工作表，无法确保所有行均按启用状态筛选")
        return candidates[0]
    finally:
        workbook.close()


def _write_filtered_workbook(source: Path, target: Path, sheet_name: str,
                             header_row: int, keep_rows: set[int]) -> None:
    """Remove unselected sheet rows while retaining original XLSX cell XML verbatim."""
    main_ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    sheet_tag = f"{{{main_ns}}}sheet"
    relationship_tag = f"{{{package_rel_ns}}}Relationship"
    with ZipFile(source, "r") as original:
        workbook_xml = ElementTree.fromstring(original.read("xl/workbook.xml"))
        sheet = next((node for node in workbook_xml.iter(sheet_tag) if node.attrib.get("name") == sheet_name), None)
        if sheet is None:
            raise AuthError("identity_mapping_failed", f"无法在工作簿结构中定位工作表 {sheet_name!r}")
        relationship_id = sheet.attrib.get(f"{{{rel_ns}}}id")
        relationships = ElementTree.fromstring(original.read("xl/_rels/workbook.xml.rels"))
        relationship = next((node for node in relationships.iter(relationship_tag)
                             if node.attrib.get("Id") == relationship_id), None)
        if relationship is None:
            raise AuthError("invalid_workbook", f"工作簿缺少工作表 {sheet_name!r} 的关系定义")
        target_path = relationship.attrib.get("Target", "")
        sheet_path = (posixpath.normpath(target_path.lstrip("/")) if target_path.startswith("/")
                      else posixpath.normpath(posixpath.join("xl", target_path)))
        sheet_xml = ElementTree.fromstring(original.read(sheet_path))
        sheet_data = sheet_xml.find(f"{{{main_ns}}}sheetData")
        if sheet_data is None:
            raise AuthError("invalid_workbook", f"工作表 {sheet_name!r} 缺少 sheetData")
        if sheet_xml.find(f"{{{main_ns}}}mergeCells") is not None:
            raise AuthError("identity_mapping_failed", "官方工作表包含合并单元格，无法安全筛选商品行")

        row_map = {row: row for row in range(1, header_row + 1)}
        row_map.update({old: header_row + index for index, old in enumerate(sorted(keep_rows), start=1)})
        bounds: tuple[int, int, int, int] | None = None
        for row in list(sheet_data):
            old_row = int(row.attrib.get("r", "0"))
            new_row = row_map.get(old_row)
            if new_row is None:
                sheet_data.remove(row)
                continue
            row.attrib["r"] = str(new_row)
            for cell in row.findall(f"{{{main_ns}}}c"):
                reference = cell.attrib.get("r", "")
                match = re.fullmatch(r"([A-Z]+)\d+", reference)
                if match:
                    cell.attrib["r"] = f"{match.group(1)}{new_row}"
                    column = column_index_from_string(match.group(1))
                    bounds = ((column, new_row, column, new_row) if bounds is None else
                              (min(bounds[0], column), min(bounds[1], new_row),
                               max(bounds[2], column), max(bounds[3], new_row)))

        final_row = header_row + len(keep_rows)
        dimension = sheet_xml.find(f"{{{main_ns}}}dimension")
        if dimension is not None and bounds is not None:
            min_column, min_row, max_column, max_row = bounds
            dimension.attrib["ref"] = (f"{get_column_letter(min_column)}{min_row}:"
                                      f"{get_column_letter(max_column)}{max_row}")
        auto_filter = sheet_xml.find(f"{{{main_ns}}}autoFilter")
        if auto_filter is not None and "ref" in auto_filter.attrib:
            match = re.fullmatch(r"([A-Z]+\d+):([A-Z]+)\d+", auto_filter.attrib["ref"])
            if match:
                auto_filter.attrib["ref"] = f"{match.group(1)}:{match.group(2)}{final_row}"
        filtered_sheet = ElementTree.tostring(sheet_xml, encoding="utf-8", xml_declaration=True)

        with ZipFile(target, "w", compression=ZIP_DEFLATED) as filtered:
            for info in original.infolist():
                filtered.writestr(info, filtered_sheet if info.filename == sheet_path else original.read(info.filename))


def filter_enabled_rows(source: Path, target: Path, records: list[dict[str, Any]]) -> dict[str, Any]:
    """Keep official workbook rows matched one-to-one to status=2 list records."""
    list_keys: list[tuple[str, str]] = []
    ids: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            raise AuthError("invalid_response", "启用商品列表包含非对象记录")
        if str(record.get("status")) != "2":
            raise AuthError("invalid_response", "启用商品列表返回了 status 不等于 2 的记录")
        record_id = _text_key(record.get("id"), field="商品ID")
        if record_id in ids:
            raise AuthError("invalid_response", f"启用商品列表出现重复商品ID {record_id!r}")
        ids.add(record_id)
        list_keys.append(_record_key(record))

    key_counts = Counter(list_keys)
    duplicate_keys = [key for key, count in key_counts.items() if count != 1]
    if duplicate_keys:
        raise AuthError("identity_mapping_failed", f"启用列表存在无法唯一关联的商品编码/创建时间键（{len(duplicate_keys)} 组）")

    sheet_name, header_row, code_column, time_column = _workbook_identity_columns(source)
    workbook = load_workbook(source, data_only=False)
    try:
        sheet = workbook[sheet_name]
        if any(cell.data_type == "f" for workbook_sheet in workbook.worksheets
               for row in workbook_sheet.iter_rows() for cell in row):
            raise AuthError("identity_mapping_failed", "官方工作簿包含公式；压缩筛选行可能改变公式引用，已停止交付")
        excel_rows: Counter[tuple[str, str]] = Counter()
        row_keys: dict[int, tuple[str, str]] = {}
        for row_number in range(header_row + 1, sheet.max_row + 1):
            code = sheet.cell(row_number, code_column + 1).value
            created = sheet.cell(row_number, time_column + 1).value
            if code in (None, "") and created in (None, ""):
                if any(cell.value not in (None, "") for cell in sheet[row_number]):
                    raise AuthError("identity_mapping_failed", f"官方工作簿第 {row_number} 行有数据但缺少身份字段")
                continue
            if code in (None, "") or created in (None, ""):
                raise AuthError("identity_mapping_failed", f"官方工作簿第 {row_number} 行身份字段不完整")
            key = (_text_key(code, field="SKU/商品编码"), _time_key(created))
            excel_rows[key] += 1
            row_keys[row_number] = key

        ambiguous = [key for key in key_counts if excel_rows[key] != 1]
        if ambiguous:
            raise AuthError("identity_mapping_failed", f"{len(ambiguous)} 条启用商品未能在官方表格中唯一匹配（缺失或重复）")

        keep_rows = {row for row, key in row_keys.items() if key in key_counts}
        _write_filtered_workbook(source, target, sheet_name, header_row, keep_rows)
        return {"row_count": len(keep_rows), "filtered_out_count": len(row_keys) - len(keep_rows),
                "matched_enabled_count": len(keep_rows)}
    finally:
        workbook.close()


class GoodsExporter:
    def __init__(self, credentials: Credentials, store: AuthStore):
        self.credentials = credentials
        self.store = store

    def _validate_download_url(self, value: Any) -> str:
        url = value.strip() if isinstance(value, str) else ""
        try:
            parsed = urlsplit(url)
            valid = (parsed.scheme == "https" and parsed.hostname in DOWNLOAD_HOSTS
                     and parsed.port in (None, 443) and not parsed.username and not parsed.password
                     and not parsed.fragment and not any(ord(c) < 33 for c in url))
        except ValueError:
            valid = False
        if not valid:
            raise AuthError("invalid_download_url", f"导出返回的下载地址不符合 HTTPS 域名约束: {_safe_urls(str(value))}")
        return url

    def _reject_token(self, token: str, detail: str) -> None:
        self.store.invalidate(token)
        raise AuthError("login_required", detail)

    async def _body(self, response: aiohttp.ClientResponse) -> str:
        chunks = bytearray()
        async for chunk in response.content.iter_chunked(65536):
            chunks.extend(chunk)
            if len(chunks) > _JSON_LIMIT:
                raise AuthError("invalid_response", "ERP 响应超过 2 MiB: "
                                + bytes(chunks[:2000]).decode(errors="replace") + " [truncated]")
        return bytes(chunks).decode("utf-8", errors="replace")

    async def _enabled_page(self, session: aiohttp.ClientSession, headers: dict[str, str],
                            token: str, page: int) -> tuple[list[dict[str, Any]], int, int]:
        async with session.get(BASE_URL + LIST_PATH, headers=headers,
                               params={"status": "2", "current": str(page), "size": str(LIST_PAGE_SIZE)},
                               allow_redirects=False) as response:
            raw = await self._body(response)
            detail = f"启用商品列表第 {page} 页 HTTP {response.status}: {raw or '[empty response]'}"
            if response.status == 401:
                self._reject_token(token, detail)
            if not 200 <= response.status < 300:
                raise AuthError("enabled_list_http_failed", detail)
            try:
                payload = json.loads(raw)
            except ValueError as exc:
                raise AuthError("invalid_response", f"启用商品列表第 {page} 页 JSON 解析失败: {exc}: {raw or '[empty response]'}") from exc

        if not isinstance(payload, dict):
            raise AuthError("invalid_response", f"启用商品列表第 {page} 页应返回对象: {raw}")
        if str(payload.get("code")) == "401":
            self._reject_token(token, detail)
        if str(payload.get("code")) != "200" or payload.get("success", True) is not True:
            raise AuthError("enabled_list_business_failed", detail)
        data = payload.get("data")
        if not isinstance(data, dict):
            raise AuthError("invalid_response", f"启用商品列表第 {page} 页缺少 data 对象: {raw}")
        rows = data.get("records")
        current, pages, total = data.get("current"), data.get("pages"), data.get("total")
        if not isinstance(rows, list):
            raise AuthError("invalid_response", f"启用商品列表第 {page} 页 records 不是数组: {raw}")
        if any(isinstance(value, bool) or not isinstance(value, int) for value in (current, pages, total)):
            raise AuthError("invalid_response", f"启用商品列表第 {page} 页缺少有效的 current/pages/total 元数据: {raw}")
        if current != page or pages < 0 or total < 0:
            raise AuthError("pagination_incomplete", f"启用商品列表页码/页数/总数异常: requested={page}, current={current}, pages={pages}, total={total}")
        if len(rows) > LIST_PAGE_SIZE:
            raise AuthError("pagination_incomplete", f"启用商品列表第 {page} 页超过请求页大小: {len(rows)} > {LIST_PAGE_SIZE}")
        return rows, pages, total

    async def _enabled_goods(self, session: aiohttp.ClientSession,
                             headers: dict[str, str], token: str) -> list[dict[str, Any]]:
        first, pages, total = await self._enabled_page(session, headers, token, 1)
        expected_pages = max(1, (total + LIST_PAGE_SIZE - 1) // LIST_PAGE_SIZE)
        if pages != expected_pages and not (total == 0 and pages == 0):
            raise AuthError("pagination_incomplete", f"启用商品列表页数与总数不一致: pages={pages}, expected={expected_pages}, total={total}")
        all_rows = list(first)
        expected_first = min(LIST_PAGE_SIZE, total)
        if len(first) != expected_first:
            raise AuthError("pagination_incomplete", f"启用商品列表第 1 页记录数异常: received={len(first)}, expected={expected_first}")
        for page in range(2, pages + 1):
            rows, page_count, page_total = await self._enabled_page(session, headers, token, page)
            expected_count = min(LIST_PAGE_SIZE, total - (page - 1) * LIST_PAGE_SIZE)
            if page_count != pages or page_total != total or len(rows) != expected_count:
                raise AuthError("pagination_incomplete", f"启用商品列表分页不连续或总数变化: page={page}, received={len(rows)}, expected={expected_count}, pages={page_count}/{pages}, total={page_total}/{total}")
            all_rows.extend(rows)
        if len(all_rows) != total:
            raise AuthError("pagination_incomplete", f"启用商品列表实际记录数与总数不一致: received={len(all_rows)}, total={total}")
        ids: set[str] = set()
        for record in all_rows:
            if not isinstance(record, dict) or str(record.get("status")) != "2":
                raise AuthError("invalid_response", "启用商品列表包含非对象记录或 status 不等于 2 的记录")
            record_id = _text_key(record.get("id"), field="商品ID")
            if record_id in ids:
                raise AuthError("pagination_incomplete", f"启用商品列表跨页出现重复商品ID {record_id!r}")
            ids.add(record_id)
        return all_rows

    async def export(self) -> dict[str, Any]:
        # Read before creating a session: missing/expired login causes no ERP request.
        token = self.store.read_token()
        headers = {"Authorization": self.credentials.basic_auth,
                   "Blade-Auth": f"bearer {token}", "Tenant-Id": self.credentials.tenant_id}
        temporary: Path | None = None
        filtered: Path | None = None
        target: Path | None = None
        directory: Path | None = None
        download_url = ""
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=180), cookie_jar=aiohttp.DummyCookieJar(),
                trust_env=False,
            ) as session:
                async with session.post(BASE_URL + EXPORT_PATH, headers=headers, allow_redirects=False) as response:
                    raw = await self._body(response)
                    detail = f"商品导出 HTTP {response.status}: {raw or '[empty response]'}"
                    if response.status == 401:
                        self._reject_token(token, detail)
                    if not 200 <= response.status < 300:
                        raise AuthError("export_http_failed", detail)
                    try:
                        payload = json.loads(raw)
                    except ValueError as exc:
                        raise AuthError("invalid_response", f"商品导出 JSON 解析失败: {exc}: {raw or '[empty response]'}") from exc
                    if not isinstance(payload, dict):
                        raise AuthError("invalid_response", f"商品导出应返回对象: {raw}")
                    if str(payload.get("code")) == "401":
                        self._reject_token(token, detail)
                    if str(payload.get("code")) != "200" or payload.get("success") is not True:
                        raise AuthError("export_business_failed", detail)
                    download_url = self._validate_download_url(payload.get("data"))

                download_host = urlsplit(download_url).hostname
                authenticated_download = download_host == urlsplit(BASE_URL).hostname
                async with session.get(download_url, headers=headers if authenticated_download else {},
                                       allow_redirects=False) as response:
                    if not 200 <= response.status < 300:
                        raw = await self._body(response)
                        detail = f"商品文件下载 HTTP {response.status}: {raw or '[empty response]'}"
                        if response.status == 401 and authenticated_download:
                            self._reject_token(token, detail)
                        raise AuthError("download_failed", detail)
                    directory = dataset_dir("shangman_goods_export", uuid4().hex)
                    directory.mkdir(parents=True, exist_ok=False)
                    filename = f"上马-商品-{datetime.now(ZoneInfo('Asia/Shanghai')):%Y%m%d-%H%M%S}.xlsx"
                    target = directory / filename
                    temporary = directory / ".download.xlsx"
                    filtered = directory / ".filtered.xlsx"
                    with temporary.open("wb") as output:
                        async for chunk in response.content.iter_chunked(65536):
                            output.write(chunk)
                metadata = validate_workbook(temporary)
                enabled_rows = await self._enabled_goods(session, headers, token)
            filtered_metadata = filter_enabled_rows(temporary, filtered, enabled_rows)
            final_metadata = validate_workbook(filtered)
            filtered.replace(target)
            temporary.unlink(missing_ok=True)
            return {"success": True, "status": "completed", "artifact_path": str(target.resolve()),
                    "filename": filename, "source": "shangman_goods_export", **metadata,
                    **filtered_metadata, "sheet_names": final_metadata["sheet_names"],
                    "data_sheet": final_metadata["data_sheet"],
                    "notice": "启用商品筛选后，报表包含完整表头，但没有商品数据行。" if filtered_metadata["row_count"] == 0 else ""}
        except Exception as exc:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            if filtered is not None:
                filtered.unlink(missing_ok=True)
            if target is not None:
                target.unlink(missing_ok=True)
            if directory is not None:
                try:
                    directory.rmdir()
                except OSError:
                    pass
            message = str(exc) if isinstance(exc, AuthError) else f"{type(exc).__name__}: {exc}"
            # Signed download queries and runtime tokens must not enter terminal output.
            message = _safe_urls(message)
            message = self.credentials.diagnostic(message, token, download_url)
            raise AuthError(getattr(exc, "code", "export_execution_failed"), message) from None


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    credentials = None
    try:
        if arguments:
            raise AuthError("invalid_arguments", "上马 ERP 商品全量导出不接受筛选或凭据参数")
        credentials = Credentials.from_environment()
        return asyncio.run(GoodsExporter(credentials, AuthStore(credentials)).export())
    except Exception as exc:
        message = str(exc) if isinstance(exc, AuthError) else f"{type(exc).__name__}: {exc}"
        return {"success": False, "status": "failed", "error": {
            "code": getattr(exc, "code", "export_execution_failed"),
            "message": credentials.diagnostic(_safe_urls(message)) if credentials else _safe_urls(message),
        }}
