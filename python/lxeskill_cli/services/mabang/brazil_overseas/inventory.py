"""Raw Mabang XLSX export for the Brazil overseas warehouse inventory view."""

from __future__ import annotations

import json
import os
from io import BytesIO
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4
from zipfile import BadZipFile, ZipFile

from shared.infra.net import erp_http_session

from services.mabang.auth import get_existing_auth_context
from services.mabang.auth_constants import PRIVATE_AMZ_HOST
from services.mabang.cookies import build_cookie_header
from services.mabang.errors import MabangAuthError, MabangBusinessError, MabangRequestError
from services.mabang.export_common import request_headers

from .contracts import (
    BRAZIL_OVERSEAS_WAREHOUSE_ID,
    BRAZIL_OVERSEAS_WAREHOUSE_LABEL,
    DEFAULT_OUTPUT_DIR,
    INVENTORY_SALES_SOURCE_NOTE,
    BrazilExportKind,
)
from .naming import BEIJING_TZ, output_filename


DEFAULT_WAREHOUSE_SEARCH_URL = "https://private-amz.mabangerp.com/index.php?mod=warehouse.searchwarehousestock"
DEFAULT_WAREHOUSE_EXPORT_URL = (
    "https://private-amz.mabangerp.com/index.php?mod=warehouse.doexportwarehousestock&flag=1&showRmbColumn=0"
)
PRIVATE_AMZ_ORIGIN = "https://private-amz.mabangerp.com"
PRIVATE_AMZ_REFERER = "https://private-amz.mabangerp.com/"
AUTH_FAILURE_STATUSES = {401}
NO_RETRY_STATUSES = {403, 429}
XLSX_ZIP_SIGNATURE = b"PK\x03\x04"


class BrazilOverseasInventoryExportError(MabangBusinessError):
    """The Brazil inventory export did not produce a usable source workbook."""


class BrazilOverseasInventoryAuthError(BrazilOverseasInventoryExportError, MabangAuthError):
    """The ERP login state is unavailable or rejected."""


@dataclass(frozen=True)
class BrazilOverseasInventoryExportResult:
    xlsx_path: str
    warehouse_id: str = BRAZIL_OVERSEAS_WAREHOUSE_ID
    warehouse_label: str = BRAZIL_OVERSEAS_WAREHOUSE_LABEL
    source_data_note: str = INVENTORY_SALES_SOURCE_NOTE

    def to_payload(self) -> dict[str, str | bool]:
        return {
            "success": True,
            "xlsx_path": self.xlsx_path,
            "warehouse_id": self.warehouse_id,
            "warehouse_label": self.warehouse_label,
            "source_data_note": self.source_data_note,
        }


def _search_form_data() -> list[tuple[str, str]]:
    """Return only the values confirmed by the Brazil warehouse capture."""
    return [
        ("stockOrderby", ""),
        ("search-content", "stocksku"),
        ("stockQuantitytype", "stockQuantitygt"),
        ("stockWarningQuantitytype", "stockWarningQuantitygt"),
        ("saleAvailableDaystype", "saleAvailableDaysgt"),
        ("showstart", "1"),
        ("timeField", "updateDate2"),
        ("warehouseMold", "all"),
        ("page", "1"),
        ("warehouseId", "undefined"),
        ("isIdn", "1"),
        ("warehouseIdArr", BRAZIL_OVERSEAS_WAREHOUSE_ID),
    ]


async def _resolve_private_amz_cookie() -> str:
    context = await get_existing_auth_context(purpose="brazil_overseas_inventory_export")
    cookie_header = build_cookie_header(
        context.cookies_by_domain,
        request_host=PRIVATE_AMZ_HOST,
        extra_cookies={"mabang_lite_rowsPerPage": "100"},
    )
    if not cookie_header:
        raise BrazilOverseasInventoryAuthError("未获取到 private-amz.mabangerp.com Cookie")
    return cookie_header


def _post_headers(cookie_header: str) -> dict[str, str]:
    return request_headers(cookie_header, origin=PRIVATE_AMZ_ORIGIN, referer=PRIVATE_AMZ_REFERER)


def _download_headers(cookie_header: str) -> dict[str, str]:
    return {
        "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*",
        "Cookie": cookie_header,
    }


async def _read_search_response(resp: Any) -> None:
    status_code = int(getattr(resp, "status", 0) or 0)
    text = await resp.text()
    if status_code in AUTH_FAILURE_STATUSES:
        raise BrazilOverseasInventoryAuthError(f"巴西海外仓库存筛选鉴权失败(status={status_code})")
    if status_code in NO_RETRY_STATUSES:
        raise MabangRequestError(f"巴西海外仓库存筛选被拒绝(status={status_code})，已停止请求")
    if status_code >= 400:
        message = text[:300] if text else "empty response"
        raise MabangRequestError(f"巴西海外仓库存筛选请求失败(status={status_code}): {message}")
    try:
        payload = json.loads(text) if text else await resp.json(content_type=None)
    except Exception as exc:
        raise BrazilOverseasInventoryExportError("巴西海外仓库存筛选返回非 JSON 数据") from exc
    if not isinstance(payload, dict):
        raise BrazilOverseasInventoryExportError("巴西海外仓库存筛选返回非 JSON 对象")
    if payload.get("success") is False:
        message = str(payload.get("msg") or payload.get("message") or payload.get("error") or "unknown").strip()
        raise BrazilOverseasInventoryExportError(f"巴西海外仓库存筛选业务异常: {message}")


def validate_xlsx(body: bytes) -> None:
    if not body:
        raise BrazilOverseasInventoryExportError("巴西海外仓库存导出返回空文件")
    if not body.startswith(XLSX_ZIP_SIGNATURE):
        preview = body.decode("utf-8", errors="replace")[:160]
        raise BrazilOverseasInventoryExportError(
            f"巴西海外仓库存导出未返回 XLSX 文件: {preview or 'unknown response'}"
        )
    try:
        with ZipFile(BytesIO(body)) as archive:
            if archive.testzip() is not None:
                raise BadZipFile("archive member checksum failed")
            file_names = set(archive.namelist())
    except BadZipFile as exc:
        raise BrazilOverseasInventoryExportError("巴西海外仓库存导出返回损坏的 XLSX 文件") from exc
    required_files = {"[Content_Types].xml", "xl/workbook.xml"}
    if not required_files.issubset(file_names):
        raise BrazilOverseasInventoryExportError("巴西海外仓库存导出未返回有效 XLSX 工作簿")


def _output_path(output_dir: str | Path | None, *, executed_at: datetime) -> Path:
    directory = Path(output_dir) if output_dir is not None else DEFAULT_OUTPUT_DIR
    directory.mkdir(parents=True, exist_ok=True)
    return directory / output_filename(BrazilExportKind.INVENTORY_SALES_SNAPSHOT, executed_at=executed_at)


def write_xlsx_atomically(target_path: Path, body: bytes) -> None:
    staged_path = target_path.with_name(f".{target_path.name}.{uuid4().hex}.tmp")
    try:
        staged_path.write_bytes(body)
        os.replace(staged_path, target_path)
    finally:
        staged_path.unlink(missing_ok=True)


async def export_brazil_overseas_inventory_sales_snapshot(
    *,
    output_dir: str | Path | None = None,
    executed_at: datetime | None = None,
) -> BrazilOverseasInventoryExportResult:
    """Export the current Brazil inventory view; the ERP XLSX includes its native sales fields."""
    cookie_header = await _resolve_private_amz_cookie()
    async with erp_http_session.post(
        DEFAULT_WAREHOUSE_SEARCH_URL,
        data=_search_form_data(),
        headers=_post_headers(cookie_header),
    ) as response:
        await _read_search_response(response)

    async with erp_http_session.get(
        DEFAULT_WAREHOUSE_EXPORT_URL,
        headers=_download_headers(cookie_header),
    ) as response:
        status_code = int(getattr(response, "status", 0) or 0)
        body = await response.read()
        if status_code in AUTH_FAILURE_STATUSES:
            raise BrazilOverseasInventoryAuthError(f"巴西海外仓库存导出鉴权失败(status={status_code})")
        if status_code in NO_RETRY_STATUSES:
            raise MabangRequestError(f"巴西海外仓库存导出被拒绝(status={status_code})，已停止请求")
        if status_code >= 400:
            message = body.decode("utf-8", errors="replace")[:300] if body else "empty response"
            raise MabangRequestError(f"巴西海外仓库存导出请求失败(status={status_code}): {message}")
    validate_xlsx(body)
    run_at = executed_at or datetime.now(BEIJING_TZ)
    target_path = _output_path(output_dir, executed_at=run_at)
    write_xlsx_atomically(target_path, body)
    return BrazilOverseasInventoryExportResult(xlsx_path=str(target_path))


__all__ = [
    "BrazilOverseasInventoryAuthError",
    "BrazilOverseasInventoryExportError",
    "BrazilOverseasInventoryExportResult",
    "export_brazil_overseas_inventory_sales_snapshot",
    "validate_xlsx",
    "write_xlsx_atomically",
]
