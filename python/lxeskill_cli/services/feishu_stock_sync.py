# -*- coding: utf-8 -*-
"""从飞书下载备货清单，清空 A 列和所有表头含「图片」的列，再移除已无引用的 WPS 单元格图片。

不依赖 Excel、LibreOffice、openpyxl 或 requests，可在 macOS/Windows 的 Python 3.9+ 运行。
越南清单保留其他工作表图片时需要 Pillow，用于生成小缩略图。
新文件会先下载、处理并校验到临时路径，成功后才原子替换本地旧文件。

用法:
    python3 -m services.feishu_stock_sync --dest "/path/to/备货清单"
"""
import argparse
import io
import json
import os
import posixpath
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from xml.etree import ElementTree as ET
from xml.sax import make_parser
from xml.sax.handler import ContentHandler
from xml.sax.saxutils import XMLGenerator
from xml.sax.xmlreader import AttributesImpl


APP_ID = os.environ.get("FEISHU_APP_ID", "")
APP_SECRET = os.environ.get("FEISHU_APP_SECRET", "")
API = "https://open.feishu.cn/open-apis"
DEST_DIR = None
FOLDER_TOKEN = os.environ.get("FEISHU_FOLDER_TOKEN", "")
IMAGE_HEADER = "图片"
TIMEZONE = timezone(timedelta(hours=8), "Asia/Shanghai")
TOKEN_ERROR_CODES = {99991661, 99991663, 99991664, 99991668}
MAPPING = {
    "拉美巴西备货清单.xlsx": "巴西",
    "东南亚越南备货清单.xlsx": "越南备货清单",
    "东南亚印度尼西亚备货清单.xlsx": "印尼",
    "东南亚新加坡备货清单.xlsx": "新加坡",
    "东南亚泰国备货清单.xlsx": "泰国",
    "东南亚台湾产品清单.xlsx": "台湾",
    "东南亚马来西亚备货清单.xlsx": "马来西亚",
    "东南亚菲律宾备货清单.xlsx": "菲律宾备货清单",
}

_LOG_LOCK = threading.Lock()
_TOKEN_LOCK = threading.Lock()
_TOKEN = None


def log(message):
    with _LOG_LOCK:
        stamp = datetime.now(TIMEZONE).strftime("%Y-%m-%d %H:%M:%S")
        print("[%s] %s" % (stamp, message), flush=True)


def _backoff(attempt):
    time.sleep(2 ** (attempt - 1))


def _json_request(url, method="GET", data=None, headers=None, attempts=3):
    body = json.dumps(data).encode("utf-8") if data is not None else None
    request_headers = {"Content-Type": "application/json"} if body else {}
    request_headers.update(headers or {})
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == attempts:
                raise RuntimeError("%s %s 失败: %s" % (method, url, exc)) from exc
            log("请求失败，%d 秒后重试 %d/%d: %s" % (2 ** (attempt - 1), attempt, attempts, exc))
            _backoff(attempt)


def get_token(force=False, stale_token=None):
    global _TOKEN
    with _TOKEN_LOCK:
        if _TOKEN and not force:
            return _TOKEN
        if force and stale_token and _TOKEN and _TOKEN != stale_token:
            return _TOKEN
        data = _json_request(
            API + "/auth/v3/tenant_access_token/internal",
            method="POST",
            data={"app_id": APP_ID, "app_secret": APP_SECRET},
        )
        if data.get("code") != 0 or not data.get("tenant_access_token"):
            raise RuntimeError("获取 token 失败: code=%s, msg=%s" % (data.get("code"), data.get("msg")))
        _TOKEN = data["tenant_access_token"]
        return _TOKEN


def _authorized_json(path, params=None):
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    token = get_token()
    for attempt in range(1, 4):
        try:
            data = _json_request(url, headers={"Authorization": "Bearer " + token}, attempts=1)
            if data.get("code") in TOKEN_ERROR_CODES:
                token = get_token(force=True, stale_token=token)
                continue
            if data.get("code") != 0:
                raise RuntimeError(json.dumps(data, ensure_ascii=False))
            return data
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                token = get_token(force=True, stale_token=token)
            elif attempt == 3 or exc.code < 500:
                raise RuntimeError("飞书请求失败 HTTP %s: %s" % (exc.code, path)) from exc
            else:
                _backoff(attempt)
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 3:
                raise RuntimeError("飞书请求失败: %s" % exc) from exc
            _backoff(attempt)
    raise RuntimeError("飞书授权失败: %s" % path)


def get_cloud_files():
    """分页列出云端文件夹，返回 {文件名: file_token}。"""
    missing = [name for name, value in (("FEISHU_APP_ID", APP_ID), ("FEISHU_APP_SECRET", APP_SECRET), ("FEISHU_FOLDER_TOKEN", FOLDER_TOKEN)) if not value]
    if missing:
        raise RuntimeError("缺少配置: " + ", ".join(missing))
    files = {}
    page_token = None
    while True:
        params = {"folder_token": FOLDER_TOKEN, "page_size": 200}
        if page_token:
            params["page_token"] = page_token
        data = _authorized_json("/drive/v1/files", params)
        page = data.get("data", {})
        files.update({item["name"]: item["token"] for item in page.get("files", [])})
        if not page.get("has_more"):
            return files
        page_token = page.get("next_page_token") or page.get("page_token")
        if not page_token:
            raise RuntimeError("飞书返回 has_more 但没有 page_token")


def _download_url(file_token):
    return API + "/drive/v1/files/" + urllib.parse.quote(file_token, safe="") + "/download"


def _validate_xlsx(path):
    if not zipfile.is_zipfile(path):
        raise RuntimeError("下载内容不是有效 XLSX/ZIP")
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError("XLSX 压缩包损坏: %s" % bad)
        required = {"[Content_Types].xml", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"}
        missing = required.difference(archive.namelist())
        if missing:
            raise RuntimeError("XLSX 缺少必要部件: %s" % sorted(missing))


def download_one(name, file_token, dest_dir, retries=3):
    """下载到临时文件并校验，不触碰已有正式文件。"""
    temp_path = os.path.join(dest_dir, ".%s.download" % name)
    if os.path.exists(temp_path):
        os.remove(temp_path)
    token = get_token()
    error = "未知错误"
    for attempt in range(1, retries + 1):
        started = time.time()
        try:
            request = urllib.request.Request(
                _download_url(file_token), headers={"Authorization": "Bearer " + token}
            )
            with urllib.request.urlopen(request, timeout=300) as response, open(temp_path, "wb") as output:
                expected = int(response.headers.get("Content-Length") or 0)
                shutil.copyfileobj(response, output, 1024 * 1024)
            actual = os.path.getsize(temp_path)
            if expected and actual != expected:
                raise RuntimeError("Content-Length 不符: %d != %d" % (actual, expected))
            if not zipfile.is_zipfile(temp_path):
                try:
                    with open(temp_path, encoding="utf-8") as error_file:
                        payload = json.load(error_file)
                except (OSError, UnicodeError, json.JSONDecodeError):
                    payload = {}
                if payload.get("code") in TOKEN_ERROR_CODES:
                    token = get_token(force=True, stale_token=token)
                if payload:
                    raise RuntimeError("飞书下载失败: %s" % json.dumps(payload, ensure_ascii=False))
            _validate_xlsx(temp_path)
            log("下载完成 %s %.1f MB，用时 %.0f 秒" % (name, actual / 1048576, time.time() - started))
            return temp_path
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                token = get_token(force=True, stale_token=token)
            error = "HTTP %s" % exc.code
        except Exception as exc:
            error = str(exc)
        if os.path.exists(temp_path):
            os.remove(temp_path)
        if attempt < retries:
            log("下载失败 %s (%s)，%d 秒后重试 %d/%d"
                % (name, error[:120], 2 ** (attempt - 1), attempt, retries))
            _backoff(attempt)
    log("下载失败 %s: %s" % (name, error))
    return None


def probe(cloud, dest_dir=DEST_DIR):
    token = get_token()
    for name in MAPPING:
        file_token = cloud.get(name)
        if not file_token:
            log("云端不存在: %s" % name)
            continue
        try:
            request = urllib.request.Request(
                _download_url(file_token), headers={"Authorization": "Bearer " + token}
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                size = int(response.headers.get("Content-Length") or 0)
            local = os.path.join(dest_dir, name)
            state = "本地已有 %.0f MB" % (os.path.getsize(local) / 1048576) if os.path.exists(local) else "本地无"
            log("%s  云端 %.0f MB  (%s)" % (name, size / 1048576, state))
        except Exception as exc:
            log("查询失败 %s: %s" % (name, exc))


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _column_number(cell_ref):
    match = re.match(r"\$?([A-Za-z]+)", cell_ref or "")
    if not match:
        return 0
    number = 0
    for char in match.group(1).upper():
        number = number * 26 + ord(char) - 64
    return number


def _relationship_owner(rel_path):
    rel_dir = posixpath.dirname(rel_path)
    owner_dir = posixpath.dirname(rel_dir)
    owner_name = posixpath.basename(rel_path)[:-5]
    return posixpath.join(owner_dir, owner_name)


def _resolve_target(rel_path, target):
    target = target.replace("\\", "/")
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(_relationship_owner(rel_path)), target))


def _sheet_path(archive, sheet_name):
    workbook = ET.parse(archive.open("xl/workbook.xml")).getroot()
    relation_id = None
    for element in workbook.iter():
        if _local_name(element.tag) == "sheet" and element.get("name") == sheet_name:
            relation_id = next((value for key, value in element.attrib.items() if _local_name(key) == "id"), None)
            break
    if not relation_id:
        actual = [element.get("name") for element in workbook.iter() if _local_name(element.tag) == "sheet"]
        raise RuntimeError("sheet「%s」不存在，实际有: %s" % (sheet_name, actual))
    rel_path = "xl/_rels/workbook.xml.rels"
    relationships = ET.parse(archive.open(rel_path)).getroot()
    for relation in relationships:
        if relation.get("Id") == relation_id:
            return _resolve_target(rel_path, relation.get("Target"))
    raise RuntimeError("sheet「%s」缺少关系 %s" % (sheet_name, relation_id))


def _shared_strings(archive, indexes):
    if not indexes:
        return {}
    if "xl/sharedStrings.xml" not in archive.namelist():
        raise RuntimeError("表头引用 sharedStrings，但 XLSX 中缺少该部件")
    values = {}
    current = 0
    with archive.open("xl/sharedStrings.xml") as source:
        context = ET.iterparse(source, events=("start", "end"))
        _, root = next(context)
        for event, element in context:
            if event == "end" and _local_name(element.tag) == "si":
                if current in indexes:
                    values[current] = "".join(node.text or "" for node in element.iter() if _local_name(node.tag) == "t")
                    if len(values) == len(indexes):
                        break
                current += 1
                root.clear()
    return values


def _read_headers(archive, sheet_path):
    raw = {}
    with archive.open(sheet_path) as source:
        context = ET.iterparse(source, events=("start", "end"))
        _, root = next(context)
        for event, element in context:
            if event != "end":
                continue
            kind = _local_name(element.tag)
            if kind == "c":
                ref = element.get("r", "")
                if re.search(r"\$?1$", ref):
                    cell_type = element.get("t")
                    if cell_type == "inlineStr":
                        value = "".join(node.text or "" for node in element.iter() if _local_name(node.tag) == "t")
                    else:
                        value_node = next((node for node in element if _local_name(node.tag) == "v"), None)
                        value = value_node.text if value_node is not None else None
                    raw[_column_number(ref)] = (cell_type, value)
                element.clear()
            elif kind == "row" and element.get("r") == "1":
                break
            elif kind == "row":
                root.clear()
    indexes = {int(value) for cell_type, value in raw.values() if cell_type == "s" and value is not None}
    shared = _shared_strings(archive, indexes)
    return {
        column: shared.get(int(value), "") if cell_type == "s" and value is not None else value
        for column, (cell_type, value) in raw.items()
    }


def _cell_has_content(element):
    return any((node.text or "").strip() for node in element.iter() if node is not element)


def _sheet_counts(archive, sheet_path, cleared_columns, cleared_cells=None):
    cleared_cells = cleared_cells or set()
    cleared = other = 0
    with archive.open(sheet_path) as source:
        context = ET.iterparse(source, events=("start", "end"))
        _, root = next(context)
        for event, element in context:
            kind = _local_name(element.tag)
            if event == "end" and kind == "c":
                if _cell_has_content(element):
                    if _column_number(element.get("r")) in cleared_columns or element.get("r") in cleared_cells:
                        cleared += 1
                    else:
                        other += 1
                element.clear()
            elif event == "end" and kind == "row":
                root.clear()
    return cleared, other


def _dispimg_cells(archive, sheet_path):
    cells = set()
    with archive.open(sheet_path) as source:
        context = ET.iterparse(source, events=("start", "end"))
        _, root = next(context)
        for event, element in context:
            kind = _local_name(element.tag)
            if event == "end" and kind == "c":
                if "DISPIMG" in "".join(node.text or "" for node in element.iter()).upper():
                    cells.add(element.get("r"))
                element.clear()
            elif event == "end" and kind == "row":
                root.clear()
    return cells


def _other_sheets_have_dispimg(archive, target_sheet):
    for path in archive.namelist():
        if path == target_sheet or not path.startswith("xl/worksheets/") or not path.endswith(".xml"):
            continue
        with archive.open(path) as source:
            context = ET.iterparse(source, events=("start", "end"))
            _, root = next(context)
            for event, element in context:
                kind = _local_name(element.tag)
                if event == "end" and kind == "c":
                    text = "".join(node.text or "" for node in element.iter())
                    if "DISPIMG" in text.upper():
                        return True
                    element.clear()
                elif event == "end" and kind == "row":
                    root.clear()
    return False


class _ClearCells(ContentHandler):
    def __init__(self, output, columns, cells):
        super().__init__()
        self.writer = XMLGenerator(output, encoding="utf-8", short_empty_elements=True)
        self.columns = columns
        self.cells = cells
        self.skipped_depth = 0

    def startDocument(self):
        self.writer.startDocument()

    def endDocument(self):
        self.writer.endDocument()

    def startElement(self, name, attrs):
        if self.skipped_depth:
            self.skipped_depth += 1
            return
        if name == "c" and (
            _column_number(attrs.get("r")) in self.columns or attrs.get("r") in self.cells
        ):
            kept = {key: attrs.getValue(key) for key in attrs.getNames() if key in ("r", "s")}
            self.writer.startElement(name, AttributesImpl(kept))
            self.skipped_depth = 1
            return
        self.writer.startElement(name, attrs)

    def endElement(self, name):
        if self.skipped_depth:
            self.skipped_depth -= 1
            if not self.skipped_depth:
                self.writer.endElement("c")
            return
        self.writer.endElement(name)

    def characters(self, content):
        if not self.skipped_depth:
            self.writer.characters(content)

    def ignorableWhitespace(self, whitespace):
        if not self.skipped_depth:
            self.writer.ignorableWhitespace(whitespace)

    def processingInstruction(self, target, data):
        if not self.skipped_depth:
            self.writer.processingInstruction(target, data)


def _rewrite_sheet(source, output, columns, cells):
    parser = make_parser()
    parser.setContentHandler(_ClearCells(output, columns, cells))
    parser.parse(source)


def _part_rel_path(part_path):
    return posixpath.join(
        posixpath.dirname(part_path), "_rels", posixpath.basename(part_path) + ".rels"
    )


def _reserved_cellimage_parts(archive):
    try:
        sheet_path = _sheet_path(archive, "WpsReserved_CellImgList")
    except RuntimeError:
        return None, set(), set()
    sheet_rel_path = _part_rel_path(sheet_path)
    if sheet_rel_path not in archive.namelist():
        return sheet_path, set(), set()
    ignored_rels = {sheet_rel_path}
    deleted_parts = {sheet_rel_path}
    root = ET.parse(archive.open(sheet_rel_path)).getroot()
    for relation in root:
        if "drawing" not in (relation.get("Type") or "").lower():
            continue
        drawing_path = _resolve_target(sheet_rel_path, relation.get("Target"))
        drawing_rel_path = _part_rel_path(drawing_path)
        deleted_parts.add(drawing_path)
        if drawing_rel_path in archive.namelist():
            deleted_parts.add(drawing_rel_path)
            ignored_rels.add(drawing_rel_path)
    return sheet_path, deleted_parts, ignored_rels


def _cellimage_media(archive, ignored_rels=None):
    rel_path = "xl/_rels/cellimages.xml.rels"
    if rel_path not in archive.namelist():
        return set()
    root = ET.parse(archive.open(rel_path)).getroot()
    candidates = {
        _resolve_target(rel_path, relation.get("Target"))
        for relation in root
        if relation.get("Target") and relation.get("TargetMode") != "External"
    }
    used_elsewhere = set()
    ignored_rels = set(ignored_rels or ()) | {rel_path}
    for path in archive.namelist():
        if not path.endswith(".rels") or path in ignored_rels:
            continue
        try:
            root = ET.parse(archive.open(path)).getroot()
        except ET.ParseError:
            continue
        for relation in root:
            target = relation.get("Target")
            if target and relation.get("TargetMode") != "External":
                resolved = _resolve_target(path, target)
                if resolved in candidates:
                    used_elsewhere.add(resolved)
    return candidates - used_elsewhere


def _remove_cellimage_reference(data):
    root = ET.fromstring(data)
    for child in list(root):
        if "cellimages" in " ".join(child.attrib.values()).lower():
            root.remove(child)
    namespace = root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else ""
    if namespace:
        ET.register_namespace("", namespace)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _remove_drawing_reference(data):
    root = ET.fromstring(data)
    for child in list(root):
        if _local_name(child.tag) == "drawing":
            root.remove(child)
    namespace = root.tag[1:].split("}", 1)[0] if root.tag.startswith("{") else ""
    if namespace:
        ET.register_namespace("", namespace)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _thumbnail_image(data):
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        image_format = image.format
        if image_format not in ("JPEG", "PNG", "WEBP") or getattr(image, "is_animated", False):
            raise RuntimeError("不支持压缩的图片格式: %s" % image_format)
        image.thumbnail((48, 48), Image.Resampling.LANCZOS)
        if image_format == "PNG":
            image = image.convert("RGBA").quantize(colors=32, method=Image.Quantize.FASTOCTREE)
        buffer = io.BytesIO()
        image.save(buffer, format=image_format, **({"quality": 30} if image_format != "PNG" else {"optimize": True}))
        candidate = buffer.getvalue()
    with Image.open(io.BytesIO(candidate)) as check:
        check.verify()
    return candidate if len(candidate) < len(data) else data


def process_xlsx(source_path, destination_path, sheet_name):
    """处理到临时文件，校验通过后原子替换 destination_path。"""
    temp_path = destination_path + ".processing"
    if os.path.exists(temp_path):
        os.remove(temp_path)
    try:
        with zipfile.ZipFile(source_path) as source:
            sheet_path = _sheet_path(source, sheet_name)
            headers = _read_headers(source, sheet_path)
            image_columns = {column for column, value in headers.items() if value and IMAGE_HEADER in str(value)}
            if not image_columns:
                raise RuntimeError("第一行没有找到含「%s」的列" % IMAGE_HEADER)
            cleared_columns = {1} | image_columns
            dispimg_cells = _dispimg_cells(source, sheet_path)
            extra_cells = {
                cell for cell in dispimg_cells if _column_number(cell) not in cleared_columns
            }
            _, before_other = _sheet_counts(source, sheet_path, cleared_columns, extra_cells)
            keep_cellimages = _other_sheets_have_dispimg(source, sheet_path)
            compress_images = sheet_name == "越南备货清单" and keep_cellimages
            if compress_images:
                try:
                    import PIL
                except ImportError as exc:
                    raise RuntimeError("越南图片压缩需要安装 Pillow；已保留正式文件") from exc
            reserved_sheet, reserved_parts, ignored_rels = _reserved_cellimage_parts(source)
            removable_media = set() if keep_cellimages else _cellimage_media(source, ignored_rels)
            deleted = set(removable_media)
            if not keep_cellimages:
                deleted.update({"xl/cellimages.xml", "xl/_rels/cellimages.xml.rels"})
                deleted.update(reserved_parts)
            compressed = set()

            with zipfile.ZipFile(temp_path, "w") as output:
                for item in source.infolist():
                    path = item.filename
                    if path in deleted:
                        continue
                    if compress_images and path.startswith("xl/media/") and not item.is_dir():
                        try:
                            data = source.read(item)
                            thumbnail = _thumbnail_image(data)
                        except Exception as exc:
                            raise RuntimeError("图片压缩失败 %s: %s" % (path, exc)) from exc
                        output.writestr(item, thumbnail)
                        if thumbnail != data:
                            compressed.add(path)
                        continue
                    if path == sheet_path:
                        with source.open(item) as input_stream, output.open(item, "w", force_zip64=True) as raw_output:
                            with io.TextIOWrapper(raw_output, encoding="utf-8", write_through=True) as text_output:
                                _rewrite_sheet(input_stream, text_output, cleared_columns, extra_cells)
                    elif not keep_cellimages and path == reserved_sheet:
                        output.writestr(item, _remove_drawing_reference(source.read(item)))
                    elif not keep_cellimages and path in ("xl/_rels/workbook.xml.rels", "[Content_Types].xml"):
                        output.writestr(item, _remove_cellimage_reference(source.read(item)))
                    else:
                        with source.open(item) as input_stream, output.open(item, "w", force_zip64=True) as output_stream:
                            shutil.copyfileobj(input_stream, output_stream, 1024 * 1024)

        _validate_xlsx(temp_path)
        with zipfile.ZipFile(source_path) as before, zipfile.ZipFile(temp_path) as after:
            after_cleared, after_other = _sheet_counts(after, sheet_path, cleared_columns, extra_cells)
            if after_cleared or after_other != before_other:
                raise RuntimeError("处理后校验失败: 目标列=%d，其他单元格=%d/%d"
                                   % (after_cleared, after_other, before_other))
            changed = deleted | compressed | {
                sheet_path, reserved_sheet, "xl/_rels/workbook.xml.rels", "[Content_Types].xml"
            }
            before_crc = {item.filename: item.CRC for item in before.infolist() if item.filename not in changed}
            after_crc = {item.filename: item.CRC for item in after.infolist() if item.filename not in changed}
            if before_crc != after_crc:
                raise RuntimeError("处理改动了非目标 XLSX 部件")
            removed_bytes = sum(item.file_size for item in before.infolist() if item.filename in deleted)

        os.replace(temp_path, destination_path)
        return len(image_columns), len(extra_cells), len(removable_media), removed_bytes, keep_cellimages, len(compressed)
    except Exception:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise


@contextmanager
def _run_lock(dest_dir):
    lock_path = os.path.join(dest_dir, ".sync_stock_lists.lock")
    lock_file = open(lock_path, "a+")
    try:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write("0")
            lock_file.flush()
        lock_file.seek(0)
        try:
            import fcntl
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except ImportError:
            import msvcrt
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        except (BlockingIOError, OSError) as exc:
            raise RuntimeError("另一个同步任务正在运行") from exc
        lock_file.truncate()
        lock_file.write(str(os.getpid()))
        lock_file.flush()
        yield
    finally:
        lock_file.close()


def sync_stock_lists(dest_dir=DEST_DIR, workers=4):
    if workers < 1:
        raise ValueError("workers 必须大于等于 1")
    os.makedirs(dest_dir, exist_ok=True)
    with _run_lock(dest_dir):
        try:
            cloud = get_cloud_files()
        except Exception as exc:
            log("列出飞书文件失败: %r" % exc)
            return False

        failed = []
        downloads = {}
        queue = [(name, token) for name in MAPPING if (token := cloud.get(name))]
        for name in MAPPING:
            if name not in cloud:
                failed.append((name, "云端不存在"))

        log("开始并发下载 %d 个文件 (%d 线程)" % (len(queue), workers))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(download_one, name, token, dest_dir): name for name, token in queue}
            for future in as_completed(futures):
                name = futures[future]
                try:
                    path = future.result()
                except Exception as exc:
                    log("下载异常 %s: %r" % (name, exc))
                    path = None
                if path:
                    downloads[name] = path
                else:
                    failed.append((name, "下载失败"))

        for name in sorted(downloads, key=lambda item: os.path.getsize(downloads[item])):
            source_path = downloads[name]
            destination_path = os.path.join(dest_dir, name)
            started = time.time()
            try:
                columns, extra, media, removed_bytes, kept, compressed = process_xlsx(
                    source_path, destination_path, MAPPING[name]
                )
                note = "，检测到其他 DISPIMG，保留 cellImages" if kept else ""
                if compressed:
                    note += "，压缩 %d 个图片为缩略图" % compressed
                log("处理完成 %s: 清空 A 列+%d 个图片列+%d 个散落图片单元格，"
                    "移除 %d 个媒体 %.1f MB%s，用时 %.0f 秒"
                    % (name, columns, extra, media, removed_bytes / 1048576,
                       note, time.time() - started))
            except Exception as exc:
                failed.append((name, "处理失败: %r" % exc))
                log("处理失败 %s，已保留本地旧文件: %r" % (name, exc))
            finally:
                if os.path.exists(source_path):
                    os.remove(source_path)

        log("总结: 成功 %d 个，失败 %d 个" % (len(MAPPING) - len(failed), len(failed)))
        for name, error in failed:
            log("  失败: %s -> %s" % (name, error))
        return not failed


def main():
    parser = argparse.ArgumentParser(description="Mac/Windows 备货清单下载、清理和瘦身")
    parser.add_argument("--dest", required=True, help="保存目录")
    parser.add_argument("--workers", type=int, choices=range(1, 17), default=1, metavar="1-16")
    parser.add_argument("--probe", action="store_true", help="只查看云端和本地文件大小")
    args = parser.parse_args()
    os.makedirs(args.dest, exist_ok=True)
    if args.probe:
        try:
            probe(get_cloud_files(), args.dest)
            return 0
        except Exception as exc:
            log("查询失败: %r" % exc)
            return 1
    return 0 if sync_stock_lists(args.dest, args.workers) else 1


if __name__ == "__main__":
    sys.exit(main())
