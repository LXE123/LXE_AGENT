"""Raw Mabang allocation XLS exports for the Brazil overseas warehouse."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from shared.infra.net import erp_http_session, external_http_session

from services.mabang.auth import get_existing_auth_context
from services.mabang.auth_constants import (
    MABANG_MEMCACHE_COOKIE_NAME,
    PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
)
from services.mabang.errors import MabangAuthError, MabangBusinessError, MabangRequestError
from services.mabang.export_common import PrivateAmzExportAuth, build_private_amz_headers, request_headers

from .contracts import (
    BRAZIL_OVERSEAS_WAREHOUSE_ID,
    BRAZIL_OVERSEAS_WAREHOUSE_LABEL,
    DEFAULT_OUTPUT_DIR,
    BrazilExportKind,
)
from .naming import BEIJING_TZ, output_filename


DEFAULT_ALLOCATION_SEARCH_URL = "https://private-amz.mabangerp.com/index.php?mod=warehouseallocation.searchallocation"
DEFAULT_ALLOCATION_EXPORT_URL = "https://private.mabangerp.com/index.php?mod=export.doAllocationWarehouseExportFile"
PRIVATE_AMZ_ORIGIN = "https://private-amz.mabangerp.com"
PRIVATE_AMZ_REFERER = "https://private-amz.mabangerp.com/index.php?mod=warehouseallocation.list&type=2"
PRIVATE_ORIGIN = "https://private.mabangerp.com"
PRIVATE_REFERER = "https://private.mabangerp.com/"
APPROVED_DOWNLOAD_HOST = "upload.mabangerp.com"
AUTH_FAILURE_STATUSES = {401}
NO_RETRY_STATUSES = {403, 429}
XLS_COMPOUND_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

ALLOCATION_FIELDLABELS = (
    "uq102",
    "uq103",
    "uq108",
    "uq109",
    "uq110",
    "uq201",
    "uq202",
    "uq203",
    "uq204",
    "uq205",
    "uq207",
    "uq2072",
    "uq208",
    "uq209",
    "uq301",
    "uq302",
    "uq304",
)
ALLOCATION_EXPORT_FIELDS = (
    ("批次编号", "uq101"),
    ("签收日期", "uq301"),
    ("目标仓位", "uq302"),
    ("签收量", "uq304"),
    ("库存SKU", "uq201"),
    ("中文名称", "uq202"),
    ("重量", "uq203"),
    ("体积重", "uq204"),
    ("起始仓位", "uq205"),
    ("调拨数量", "uq207"),
    ("单价(RMB)", "uq2072"),
    ("待签收数量", "uq208"),
    ("总入库数量", "uq209"),
    ("起始仓库", "uq102"),
    ("目标仓库", "uq103"),
    ("发货日期", "uq108"),
    ("预期到货日期", "uq109"),
    ("最近签收日期", "uq110"),
)


class BrazilOverseasAllocationExportError(MabangBusinessError):
    """The Brazil allocation export did not produce a usable source workbook."""


class BrazilOverseasAllocationAuthError(BrazilOverseasAllocationExportError, MabangAuthError):
    """The ERP login state is unavailable or rejected."""


@dataclass(frozen=True)
class BrazilOverseasAllocationExportResult:
    kind: BrazilExportKind
    xlsx_path: str
    warehouse_id: str = BRAZIL_OVERSEAS_WAREHOUSE_ID
    warehouse_label: str = BRAZIL_OVERSEAS_WAREHOUSE_LABEL

    def to_payload(self) -> dict[str, str | bool]:
        return {
            "success": True,
            "kind": self.kind.value,
            "xlsx_path": self.xlsx_path,
            "warehouse_id": self.warehouse_id,
            "warehouse_label": self.warehouse_label,
        }


def _status_for_kind(kind: BrazilExportKind) -> str:
    if kind is BrazilExportKind.ALLOCATION_SIGNED_BEFORE_3M:
        return "4"
    if kind is BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M:
        return "2"
    raise ValueError("仅支持三个月前已签收或三个月内待签收调拨导出")


def _tablebase_for_kind(kind: BrazilExportKind) -> str:
    """Use only the time shortcuts confirmed in the allocation-signing page."""
    if kind is BrazilExportKind.ALLOCATION_SIGNED_BEFORE_3M:
        return "2"
    if kind is BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M:
        return ""
    raise ValueError("仅支持三个月前已签收或三个月内待签收调拨导出")


def _search_form_data(kind: BrazilExportKind) -> list[tuple[str, str]]:
    return [
        ("mod", "warehouseallocation.searchallocation"),
        ("orderBys[]", ""),
        ("warehouseMold", "all"),
        ("startWarehouseIdStr", ""),
        ("targetWarehouseIdStr", ""),
        ("search-content1", "allocationCode"),
        ("search-content-text1", ""),
        ("tablebase", _tablebase_for_kind(kind)),
        ("Orderby", ""),
        ("startWarehouseIdStr", ""),
        ("third_in_status", "undefined"),
        ("third_out_status", "undefined"),
        ("page", "1"),
        ("rowsPerPage", "20"),
        ("type", "2"),
        ("allocationstatus", _status_for_kind(kind)),
        ("startwarhouseId", ""),
        ("targetwarhouseId", BRAZIL_OVERSEAS_WAREHOUSE_ID),
        ("timetype", "timeCreated"),
        ("datepickerfrom", ""),
        ("datepickerto", ""),
        ("isBatchSearch", "0"),
        ("selecttype", "allocationCode"),
        ("stockData", ""),
        ("orderbysVal", ""),
        ("orderbydac", ""),
        ("auditStatus", "0"),
        ("labelId", ""),
        ("freight_set", ""),
        ("transportType", ""),
    ]


def _export_form_data(*, memcache_key: str, order_ids: str) -> list[tuple[str, str]]:
    form: list[tuple[str, str]] = [
        ("mod", "export.doAllocationWarehouseExportFile"),
        ("backUrl", ""),
        ("orderIds", order_ids),
    ]
    form.extend(("fieldlabel", field) for field in ALLOCATION_FIELDLABELS)
    for name, field in ALLOCATION_EXPORT_FIELDS:
        form.extend(
            [
                ("map-name[]", name),
                ("map-uq[]", field),
                ("map-text[]", ""),
            ]
        )
    form.extend(
        [
            ("templateName", ""),
            ("templateId", "1058049"),
            ("datasOpen", "2"),
            ("memcacheKey", memcache_key),
            ("showRmbColumn", "0"),
            ("pageSave", "1"),
            ("operateType", "17"),
            ("params", ""),
            ("InterfaceUrl", ""),
            ("mainMenu", ""),
            ("hiddenPage", ""),
            ("hiddenPageSize", ""),
            ("tableBase", ""),
            ("isMerage", "1"),
            ("showRmbColumn", "0"),
        ]
    )
    return form


def _extract_order_ids(payload: dict[str, Any]) -> str:
    """Extract only numeric allocation IDs rendered by the confirmed list response."""
    sources = [payload.get("message"), payload.get("pageHtml")]
    found: list[str] = []
    patterns = (
        re.compile(r"name\s*=\s*[\"']orderIds(?:\[\])?[\"'][^>]*value\s*=\s*[\"']([0-9]+)[\"']", re.IGNORECASE),
        re.compile(r"(?:data-)?order-id\s*=\s*[\"']([0-9]+)[\"']", re.IGNORECASE),
        re.compile(r"warehouseallocation\.editallocation[^>]*(?:\?|&|&amp;)id=([0-9]+)", re.IGNORECASE),
    )
    for source in sources:
        if not isinstance(source, str):
            continue
        for pattern in patterns:
            for value in pattern.findall(source):
                if value not in found:
                    found.append(value)
    if not found:
        raise BrazilOverseasAllocationExportError("分仓调拨筛选结果未返回可导出的 orderIds")
    return ",".join(found) + ","


async def resolve_brazil_allocation_export_auth() -> PrivateAmzExportAuth:
    context = await get_existing_auth_context(purpose="brazil_overseas_allocation_export")
    return build_private_amz_headers(
        context,
        required_names=PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
        extra_cookies={"mabang_lite_rowsPerPage": "100"},
        private_extra_cookies={"exportv2": "2"},
        memcache_cookie_name=MABANG_MEMCACHE_COOKIE_NAME,
        error_type=BrazilOverseasAllocationAuthError,
    )


async def _read_json_response(response: Any, *, action: str) -> dict[str, Any]:
    status_code = int(getattr(response, "status", 0) or 0)
    text = await response.text()
    if status_code in AUTH_FAILURE_STATUSES:
        raise BrazilOverseasAllocationAuthError(f"{action}鉴权失败(status={status_code})")
    if status_code in NO_RETRY_STATUSES:
        raise MabangRequestError(f"{action}被拒绝(status={status_code})，已停止请求")
    if status_code >= 400:
        message = text[:300] if text else "empty response"
        raise MabangRequestError(f"{action}请求失败(status={status_code}): {message}")
    try:
        payload = json.loads(text) if text else await response.json(content_type=None)
    except Exception as exc:
        raise BrazilOverseasAllocationExportError(f"{action}返回非 JSON 数据") from exc
    if not isinstance(payload, dict):
        raise BrazilOverseasAllocationExportError(f"{action}返回非 JSON 对象")
    if payload.get("success") is not True:
        message = str(payload.get("msg") or payload.get("message") or payload.get("error") or "unknown").strip()
        raise BrazilOverseasAllocationExportError(f"{action}业务异常: {message}")
    return payload


def _parse_gourl(payload: dict[str, Any]) -> str:
    gourl = str(payload.get("gourl") or "").strip()
    parsed = urlsplit(gourl)
    if not gourl:
        raise BrazilOverseasAllocationExportError("分仓调拨导出返回缺少 gourl")
    if parsed.scheme != "https" or parsed.hostname != APPROVED_DOWNLOAD_HOST:
        raise BrazilOverseasAllocationExportError("分仓调拨导出返回了未批准的下载地址")
    return gourl


async def _download_xls(gourl: str) -> bytes:
    headers = {
        "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/octet-stream,*/*"
    }
    async with external_http_session.get(gourl, headers=headers) as response:
        status_code = int(getattr(response, "status", 0) or 0)
        body = await response.read()
    if status_code in AUTH_FAILURE_STATUSES:
        raise BrazilOverseasAllocationAuthError(f"分仓调拨导出文件下载鉴权失败(status={status_code})")
    if status_code in NO_RETRY_STATUSES:
        raise MabangRequestError(f"分仓调拨导出文件下载被拒绝(status={status_code})，已停止请求")
    if status_code >= 400:
        message = body.decode("utf-8", errors="replace")[:300] if body else "empty response"
        raise MabangRequestError(f"分仓调拨导出文件下载失败(status={status_code}): {message}")
    validate_xls(body)
    return body


def validate_xls(body: bytes) -> None:
    """Reject HTML/empty responses while accepting the ERP's legacy XLS file."""
    if not body.startswith(XLS_COMPOUND_SIGNATURE):
        preview = body[:120].decode("utf-8", errors="replace").strip()
        raise BrazilOverseasAllocationExportError(
            f"巴西海外仓分仓调拨导出未返回 XLS 文件: {preview or 'unknown response'}"
        )


def write_xls_atomically(target_path: Path, body: bytes) -> None:
    temporary_path = target_path.with_name(f".{target_path.name}.{uuid4().hex}.tmp")
    try:
        temporary_path.write_bytes(body)
        os.replace(temporary_path, target_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _output_path(kind: BrazilExportKind, output_dir: str | Path | None, *, executed_at: datetime) -> Path:
    directory = Path(output_dir) if output_dir is not None else DEFAULT_OUTPUT_DIR
    directory.mkdir(parents=True, exist_ok=True)
    return directory / output_filename(kind, executed_at=executed_at, extension="xls")


async def export_brazil_overseas_allocation(
    kind: BrazilExportKind,
    *,
    output_dir: str | Path | None = None,
    executed_at: datetime | None = None,
) -> BrazilOverseasAllocationExportResult:
    """Export the confirmed signed or default-three-month pending allocation view."""
    _status_for_kind(kind)
    auth = await resolve_brazil_allocation_export_auth()
    async with erp_http_session.post(
        DEFAULT_ALLOCATION_SEARCH_URL,
        data=_search_form_data(kind),
        headers=request_headers(auth.private_amz_cookie_header, origin=PRIVATE_AMZ_ORIGIN, referer=PRIVATE_AMZ_REFERER),
    ) as response:
        search_response = await _read_json_response(response, action="巴西海外仓分仓调拨筛选")
    order_ids = _extract_order_ids(search_response)
    async with erp_http_session.post(
        DEFAULT_ALLOCATION_EXPORT_URL,
        data=_export_form_data(memcache_key=auth.memcache_key, order_ids=order_ids),
        headers=request_headers(auth.private_cookie_header, origin=PRIVATE_ORIGIN, referer=PRIVATE_REFERER),
    ) as response:
        export_response = await _read_json_response(response, action="巴西海外仓分仓调拨导出")
    body = await _download_xls(_parse_gourl(export_response))
    run_at = executed_at or datetime.now(BEIJING_TZ)
    target_path = _output_path(kind, output_dir, executed_at=run_at)
    write_xls_atomically(target_path, body)
    return BrazilOverseasAllocationExportResult(kind=kind, xlsx_path=str(target_path))


__all__ = [
    "ALLOCATION_EXPORT_FIELDS",
    "ALLOCATION_FIELDLABELS",
    "BrazilOverseasAllocationAuthError",
    "BrazilOverseasAllocationExportError",
    "BrazilOverseasAllocationExportResult",
    "validate_xls",
    "write_xls_atomically",
    "export_brazil_overseas_allocation",
    "resolve_brazil_allocation_export_auth",
]
