from __future__ import annotations

import asyncio
import json
import re
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from shared.infra.net import erp_http_session, external_http_session
from services.mabang import config as mabang_settings
from services.mabang.auth_constants import MABANG_MEMCACHE_COOKIE_NAME as MEMCACHE_COOKIE_NAME, PRIVATE_HOST

from .auth import get_auth_context
from .cookies import build_cookie_header, extract_named_cookies
from .errors import MabangAuthError, MabangBusinessError, MabangRequestError

DEFAULT_STOCK_EXPORT_URL = "https://private.mabangerp.com/index.php?mod=export.doStockExportFile"
DEFAULT_STOCK_EXPORT_ORIGIN = "https://private.mabangerp.com"
DEFAULT_STOCK_EXPORT_REFERER = "https://private.mabangerp.com/"
DEFAULT_OUTPUT_DIR = Path("artifacts") / "mabang_stock_sku"
MAX_SKUS_PER_BATCH = 3000
STOCK_SKU_COLUMN = "库存SKU"
STOCK_SKU_NAME_COLUMN = "库存SKU中文名称"
STOCK_SKU_WAREHOUSE_ID = "1014318"
STOCK_SKU_EXPORT_FIELDS: tuple[tuple[str, str], ...] = (
    (STOCK_SKU_COLUMN, "uq101"),
    (STOCK_SKU_NAME_COLUMN, "uq103"),
    ("库存sku图片", "uq1244"),
    ("库存总量（按勾选仓库）", "uq2161"),
    ("可用库存总量（按勾选仓库）", "uq2162"),
    ("未发货总量（按勾选仓库）", "uq2163"),
    ("最新采购价(RMB)", "uq1271"),
    ("最低采购价(RMB)", "uq1272"),
    ("标准采购价(RMB)", "uq1273"),
    ("仓库名称", "uq222"),
    ("仓库可用库存量", "uq254"),
)
AUTH_FAIL_STATUS = {401, 403}
SOURCE = "mabang_stock_sku_export"
WHITESPACE_PATTERN = re.compile(r"\s+")


class StockSkuExportError(MabangBusinessError):
    pass


class StockSkuExportAuthError(StockSkuExportError, MabangAuthError):
    pass


class StockSkuExportTimeoutError(StockSkuExportError):
    pass


@dataclass(frozen=True)
class StockSkuBatchExport:
    batch_index: int
    sku_count: int
    sn: str
    task_id: str
    subtask_num: int
    chunk_num: int | None
    file_url: str
    xlsx_path: str


@dataclass(frozen=True)
class StockSkuNameExportResult:
    names_by_key: OrderedDict[str, str]
    xlsx_paths: list[str]
    batches: list[StockSkuBatchExport]
    requested_sku_count: int
    source: str = SOURCE


def _configured_text(name: str, default: str) -> str:
    return mabang_settings.configured_text(name, default)


def _clean_cell(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower() == "nan":
        return ""
    return text


def normalize_sku_key(value: Any) -> str:
    return WHITESPACE_PATTERN.sub("", _clean_cell(value))


def _unique_skus(values: list[str] | tuple[str, ...] | Any) -> list[str]:
    unique: OrderedDict[str, str] = OrderedDict()
    for value in values or []:
        sku = _clean_cell(value)
        key = normalize_sku_key(sku)
        if not key or key in unique:
            continue
        unique[key] = sku
    return list(unique.values())


def _chunked(values: list[str], size: int) -> list[list[str]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def _safe_file_part(value: Any) -> str:
    text = str(value or "").strip()
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    return text.strip("._-") or "stock_sku"


def _int_value(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _resolve_output_dir(output_dir: str | Path | None = None) -> Path:
    if output_dir is not None:
        path = Path(output_dir)
    else:
        configured = str(mabang_settings.MABANG_STOCK_SKU_EXPORT_DIR or "").strip()
        path = Path(configured) if configured else DEFAULT_OUTPUT_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def _request_headers(cookie_header: str) -> dict[str, str]:
    return {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": _configured_text("MABANG_STOCK_SKU_EXPORT_ORIGIN", DEFAULT_STOCK_EXPORT_ORIGIN),
        "Referer": _configured_text("MABANG_STOCK_SKU_EXPORT_REFERER", DEFAULT_STOCK_EXPORT_REFERER),
        "Cookie": cookie_header,
    }


def _stock_export_url() -> str:
    return _configured_text("MABANG_STOCK_SKU_EXPORT_URL", DEFAULT_STOCK_EXPORT_URL)


async def _read_stock_export_json(resp: Any, *, action: str) -> dict[str, Any]:
    status_code = int(getattr(resp, "status", 0) or 0)
    text = await resp.text()
    if status_code in AUTH_FAIL_STATUS:
        raise StockSkuExportAuthError(f"{action}鉴权失败(status={status_code})")
    if status_code >= 400:
        msg = text[:300] if text else "empty response"
        raise MabangRequestError(f"{action}请求失败(status={status_code}): {msg}")

    data: Any = None
    if text:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = None
    if data is None:
        try:
            data = await resp.json(content_type=None)
        except Exception:
            data = None
    if not isinstance(data, dict):
        raise StockSkuExportError(f"{action}返回非JSON对象")
    if data.get("success") is False:
        message = str(data.get("msg") or data.get("message") or data.get("error") or "unknown").strip()
        raise StockSkuExportError(f"{action}业务异常: {message}")
    return data


async def _resolve_private_auth() -> tuple[str, str]:
    context = await get_auth_context(scope="erp")
    cookie_header = build_cookie_header(
        context.cookies_by_domain,
        request_host=PRIVATE_HOST,
        extra_cookies={"exportv2": "1"},
    )
    if not cookie_header:
        raise StockSkuExportAuthError("未获取到 private.mabangerp.com Cookie")

    values = extract_named_cookies(context.cookies_by_domain, (MEMCACHE_COOKIE_NAME,))
    memcache_key = str(values.get(MEMCACHE_COOKIE_NAME) or "").strip()
    if not memcache_key:
        raise StockSkuExportAuthError(f"缺少关键 Cookie: {MEMCACHE_COOKIE_NAME}")
    return cookie_header, memcache_key


def _step1_form_data(skus: list[str], *, memcache_key: str) -> list[tuple[str, str]]:
    order_ids = "\r\n".join(skus) + "\r\n"
    form: list[tuple[str, str]] = [
        ("backUrl", ""),
        ("orderIds", order_ids),
    ]
    form.extend(("fieldlabel", uq) for _, uq in STOCK_SKU_EXPORT_FIELDS)
    form.append(("warehouseIds[]", STOCK_SKU_WAREHOUSE_ID))
    for name, uq in STOCK_SKU_EXPORT_FIELDS:
        form.extend(
            [
                ("map-name[]", name),
                ("map-uq[]", uq),
                ("map-text[]", ""),
            ]
        )
    form.extend(
        [
            ("templateName", ""),
            ("templateId", "0"),
            ("datasOpen", "1"),
            ("memcacheKey", memcache_key),
            ("showRmbColumn", "2"),
            ("pageSave", "1"),
            ("operateType", "3"),
            ("params", ""),
            ("InterfaceUrl", ""),
            ("mainMenu", ""),
            ("hiddenPage", ""),
            ("hiddenPageSize", ""),
            ("tableBase", ""),
            ("isMerage", "1"),
            ("version", "v2"),
            ("step", "1"),
        ]
    )
    return form


def _step2_form_data(*, sn: str, sub_no: int) -> list[tuple[str, str]]:
    return [
        ("tableBase", ""),
        ("isMerage", "1"),
        ("version", "v2"),
        ("sn", sn),
        ("sub_no", str(sub_no)),
        ("step", "2"),
        ("1", "1"),
    ]


def _step3_form_data(*, sn: str) -> list[tuple[str, str]]:
    return [
        ("tableBase", ""),
        ("isMerage", "1"),
        ("sn", sn),
        ("version", "v2"),
        ("step", "3"),
        ("1", "1"),
    ]


def _step4_form_data(*, sn: str, task_id: str) -> list[tuple[str, str]]:
    return [
        ("tableBase", ""),
        ("isMerage", "1"),
        ("sn", sn),
        ("version", "v2"),
        ("step", "4"),
        ("taskId", task_id),
        ("1", "1"),
    ]


async def _post_stock_export(
    form_data: list[tuple[str, str]],
    *,
    cookie_header: str,
    action: str,
) -> dict[str, Any]:
    async with erp_http_session.post(
        _stock_export_url(),
        data=form_data,
        headers=_request_headers(cookie_header),
    ) as resp:
        return await _read_stock_export_json(resp, action=action)


def _normalize_step1_response(payload: dict[str, Any]) -> tuple[str, int, int | None]:
    sn = str(payload.get("sn") or "").strip()
    if not sn:
        raise StockSkuExportError("库存SKU导出 Step 1 返回缺少 sn")
    subtask_num = _int_value(payload.get("subtask_num"))
    if not subtask_num or subtask_num <= 0:
        raise StockSkuExportError(f"库存SKU导出 Step 1 返回 subtask_num 无效: {payload.get('subtask_num')}")
    chunk_num = _int_value(payload.get("chunkNum"))
    return sn, subtask_num, chunk_num


def _validate_step2_response(payload: dict[str, Any], *, sub_no: int) -> None:
    sub_items = payload.get("subO")
    if not isinstance(sub_items, list) or not sub_items:
        raise StockSkuExportError(f"库存SKU导出 Step 2 返回缺少 subO: sub_no={sub_no}")
    for item in sub_items:
        if not isinstance(item, dict):
            raise StockSkuExportError(f"库存SKU导出 Step 2 返回 subO 格式异常: sub_no={sub_no}")
        if str(item.get("success") or "").strip() != "1":
            raise StockSkuExportError(f"库存SKU导出 Step 2 失败: sub_no={sub_no}, subO={item}")


def _normalize_step3_response(payload: dict[str, Any]) -> str:
    task_id = str(payload.get("taskId") or "").strip()
    if not task_id:
        raise StockSkuExportError("库存SKU导出 Step 3 返回缺少 taskId")
    return task_id


async def _wait_for_file_url(
    *,
    sn: str,
    task_id: str,
    cookie_header: str,
    timeout_sec: float,
    poll_interval_sec: float,
) -> str:
    safe_timeout = max(0.0, float(timeout_sec))
    safe_interval = max(0.1, float(poll_interval_sec))
    deadline = asyncio.get_running_loop().time() + safe_timeout
    last_state = "unknown"

    while True:
        payload = await _post_stock_export(
            _step4_form_data(sn=sn, task_id=task_id),
            cookie_header=cookie_header,
            action="库存SKU导出 Step 4",
        )
        state = str(payload.get("state") or "").strip()
        last_state = state or "unknown"
        file_url = str(payload.get("file_url") or "").strip()
        if state == "1":
            if not file_url:
                raise StockSkuExportError(f"库存SKU导出完成但缺少 file_url: taskId={task_id}")
            return file_url

        now = asyncio.get_running_loop().time()
        if now >= deadline:
            break
        await asyncio.sleep(min(safe_interval, max(0.0, deadline - now)))

    raise StockSkuExportTimeoutError(
        f"库存SKU导出超时(taskId={task_id}, timeout={safe_timeout:g}s, last_state={last_state})"
    )


async def download_stock_sku_xlsx_from_url(
    file_url: str,
    *,
    delivery_no: str,
    batch_index: int,
    output_dir: str | Path | None = None,
) -> Path:
    url = str(file_url or "").strip()
    if not url:
        raise ValueError("file_url 不能为空")

    directory = _resolve_output_dir(output_dir)
    prefix = _safe_file_part(delivery_no) if str(delivery_no or "").strip() else "stock_sku"
    target_path = directory / f"{prefix}_batch{int(batch_index):03d}.xlsx"
    headers = {
        "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*"
    }
    async with external_http_session.get(url, headers=headers) as resp:
        status_code = int(getattr(resp, "status", 0) or 0)
        body = await resp.read()
        if status_code >= 400:
            msg = body.decode("utf-8", errors="replace")[:300] if body else "empty response"
            raise MabangRequestError(f"下载库存SKU导出xlsx失败(status={status_code}): {msg}")
        if not body:
            raise StockSkuExportError("下载库存SKU导出xlsx返回空文件")

    target_path.write_bytes(body)
    return target_path


def load_stock_sku_names(xlsx_path: str | Path) -> OrderedDict[str, str]:
    source_path = Path(xlsx_path).expanduser()
    if not source_path.is_file():
        raise RuntimeError(f"找不到库存SKU导出xlsx: {source_path}")

    try:
        import pandas as pd
    except Exception as exc:
        raise RuntimeError("缺少 pandas 依赖，无法读取库存SKU导出xlsx") from exc

    try:
        df = pd.read_excel(source_path, sheet_name=0, dtype=str)
    except Exception as exc:
        raise RuntimeError(f"读取库存SKU导出xlsx失败: {source_path}, error={exc}") from exc

    columns = [str(column or "").strip() for column in list(df.columns)]
    df.columns = columns
    if not columns and df.empty:
        raise RuntimeError("库存SKU导出结果为空，可能这些库存 SKU 在马帮库存中查不到")
    missing_columns = [column for column in (STOCK_SKU_COLUMN, STOCK_SKU_NAME_COLUMN) if column not in columns]
    if missing_columns:
        raise RuntimeError(f"库存SKU导出xlsx缺少列: {', '.join(missing_columns)}")

    names: OrderedDict[str, str] = OrderedDict()
    for row in df.to_dict(orient="records"):
        sku = _clean_cell(row.get(STOCK_SKU_COLUMN))
        key = normalize_sku_key(sku)
        if not key or key in names:
            continue
        names[key] = _clean_cell(row.get(STOCK_SKU_NAME_COLUMN))
    return names


async def export_stock_sku_batch(
    skus: list[str],
    *,
    delivery_no: str,
    batch_index: int,
    cookie_header: str,
    memcache_key: str,
    timeout_sec: float = 180,
    poll_interval_sec: float = 3,
    output_dir: str | Path | None = None,
) -> StockSkuBatchExport:
    unique = _unique_skus(skus)
    if not unique:
        raise ValueError("库存SKU导出批次不能为空")
    if len(unique) > MAX_SKUS_PER_BATCH:
        raise ValueError(f"库存SKU单批最多支持 {MAX_SKUS_PER_BATCH} 个")

    step1 = await _post_stock_export(
        _step1_form_data(unique, memcache_key=memcache_key),
        cookie_header=cookie_header,
        action="库存SKU导出 Step 1",
    )
    sn, subtask_num, chunk_num = _normalize_step1_response(step1)

    for sub_no in range(1, subtask_num + 1):
        step2 = await _post_stock_export(
            _step2_form_data(sn=sn, sub_no=sub_no),
            cookie_header=cookie_header,
            action="库存SKU导出 Step 2",
        )
        _validate_step2_response(step2, sub_no=sub_no)

    step3 = await _post_stock_export(
        _step3_form_data(sn=sn),
        cookie_header=cookie_header,
        action="库存SKU导出 Step 3",
    )
    task_id = _normalize_step3_response(step3)
    file_url = await _wait_for_file_url(
        sn=sn,
        task_id=task_id,
        cookie_header=cookie_header,
        timeout_sec=timeout_sec,
        poll_interval_sec=poll_interval_sec,
    )
    xlsx_path = await download_stock_sku_xlsx_from_url(
        file_url,
        delivery_no=delivery_no,
        batch_index=batch_index,
        output_dir=output_dir,
    )
    return StockSkuBatchExport(
        batch_index=batch_index,
        sku_count=len(unique),
        sn=sn,
        task_id=task_id,
        subtask_num=subtask_num,
        chunk_num=chunk_num,
        file_url=file_url,
        xlsx_path=str(xlsx_path),
    )


async def export_stock_sku_names(
    skus: list[str] | tuple[str, ...],
    *,
    delivery_no: str = "",
    timeout_sec: float = 180,
    poll_interval_sec: float = 3,
    output_dir: str | Path | None = None,
) -> StockSkuNameExportResult:
    unique = _unique_skus(skus)
    if not unique:
        return StockSkuNameExportResult(
            names_by_key=OrderedDict(),
            xlsx_paths=[],
            batches=[],
            requested_sku_count=0,
        )

    cookie_header, memcache_key = await _resolve_private_auth()
    names_by_key: OrderedDict[str, str] = OrderedDict()
    batches: list[StockSkuBatchExport] = []

    for batch_index, batch_skus in enumerate(_chunked(unique, MAX_SKUS_PER_BATCH), start=1):
        batch = await export_stock_sku_batch(
            batch_skus,
            delivery_no=delivery_no,
            batch_index=batch_index,
            cookie_header=cookie_header,
            memcache_key=memcache_key,
            timeout_sec=timeout_sec,
            poll_interval_sec=poll_interval_sec,
            output_dir=output_dir,
        )
        batches.append(batch)
        for key, name in load_stock_sku_names(batch.xlsx_path).items():
            if key not in names_by_key:
                names_by_key[key] = name

    return StockSkuNameExportResult(
        names_by_key=names_by_key,
        xlsx_paths=[batch.xlsx_path for batch in batches],
        batches=batches,
        requested_sku_count=len(unique),
    )


__all__ = [
    "MAX_SKUS_PER_BATCH",
    "STOCK_SKU_COLUMN",
    "STOCK_SKU_EXPORT_FIELDS",
    "STOCK_SKU_NAME_COLUMN",
    "STOCK_SKU_WAREHOUSE_ID",
    "StockSkuBatchExport",
    "StockSkuExportAuthError",
    "StockSkuExportError",
    "StockSkuExportTimeoutError",
    "StockSkuNameExportResult",
    "download_stock_sku_xlsx_from_url",
    "export_stock_sku_batch",
    "export_stock_sku_names",
    "load_stock_sku_names",
    "normalize_sku_key",
]
