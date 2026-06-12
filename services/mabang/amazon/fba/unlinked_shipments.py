from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from shared.infra.net import erp_http_session, external_http_session
from services.mabang import config as mabang_settings

from ...auth import get_fba_free_token
from ...errors import MabangBusinessError, MabangRequestError
from .batch_delivery import (
    DEFAULT_BATCH_DELIVERY_LIST_URL,
    DEFAULT_TASK_PUSH_URL,
    SIMPLE_TASK_CONFIG_ID,
    _configured_text,
    _int_value,
    _read_api_json,
    _request_headers,
    request_download_info,
    wait_for_delivery_task,
)

DEFAULT_SHOP_COUNTRY_URL = "https://api-private.mabangerp.com/fba/api/v1/shop/shopCountry"
DEFAULT_OUTPUT_DIR = Path("artifacts") / "mabang_fba_unlinked_shipments"
SOURCE = "mabang_fba_unlinked_shipments"


class UnlinkedShipmentError(MabangBusinessError):
    pass


@dataclass(frozen=True)
class ShopOption:
    store_id: int
    name: str
    raw: dict[str, Any]


@dataclass(frozen=True)
class UnlinkedShipmentStatusSpec:
    status_name: str
    params: dict[str, Any]


@dataclass(frozen=True)
class UnlinkedShipmentStatusResult:
    status_name: str
    total: int
    task_id: int | None = None
    file_hash: str = ""
    file_name: str = ""
    raw_file_path: str = ""

    def to_payload(self) -> dict[str, Any]:
        return {
            "status_name": self.status_name,
            "total": self.total,
            "task_id": self.task_id,
            "file_hash": self.file_hash,
            "file_name": self.file_name,
            "raw_file_path": self.raw_file_path,
        }


@dataclass(frozen=True)
class StoreUnlinkedShipmentDownloadResult:
    store_name: str
    store_id: int
    download_time: str
    status_results: list[UnlinkedShipmentStatusResult]
    source: str = SOURCE

    def to_payload(self) -> dict[str, Any]:
        return {
            "success": True,
            "store_name": self.store_name,
            "store_id": self.store_id,
            "download_time": self.download_time,
            "status_results": [row.to_payload() for row in self.status_results],
            "source": self.source,
        }


UNLINKED_SHIPMENT_STATUS_SPECS = (
    UnlinkedShipmentStatusSpec(
        status_name="WMS待配货",
        params={"status": 6, "is_batch_create": 1, "delivery_type": 2},
    ),
    UnlinkedShipmentStatusSpec(
        status_name="WMS待装箱",
        params={"status": 9, "is_batch_create": 1},
    ),
    UnlinkedShipmentStatusSpec(
        status_name="待关联货件",
        params={"status": 10, "is_batch_create": 1},
    ),
)


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def normalize_store_name(value: Any) -> str:
    store_name = _clean_text(value)
    if not store_name:
        raise ValueError("store_name 不能为空")
    return store_name


def _safe_path_part(value: Any, *, fallback: str) -> str:
    text = _clean_text(value)
    text = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", text)
    text = re.sub(r"\s+", "_", text)
    return text.strip(" ._-") or fallback


def _configured_path(name: str, default: Path) -> Path:
    return mabang_settings.configured_path(name, default)


def _output_dir(output_dir: str | Path | None = None) -> Path:
    path = Path(output_dir) if output_dir is not None else _configured_path(
        "MABANG_FBA_UNLINKED_SHIPMENTS_OUTPUT_DIR",
        DEFAULT_OUTPUT_DIR,
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


def _today_text(report_date: str | date | None = None) -> str:
    if isinstance(report_date, date):
        return report_date.isoformat()
    text = _clean_text(report_date)
    if text:
        return text
    return date.today().isoformat()


def _timestamp_text(value: str | None = None) -> str:
    text = _clean_text(value)
    if text:
        return text
    return datetime.now().strftime("%Y%m%d%H%M")


def safe_poll_interval_sec(value: float | int | str | None) -> float:
    try:
        number = float(10 if value is None else value)
    except (TypeError, ValueError):
        return 10.0
    if math.isnan(number):
        return 10.0
    return max(10.0, number)


def safe_timeout_sec(value: float | int | str | None) -> float:
    try:
        number = float(180 if value is None else value)
    except (TypeError, ValueError):
        return 180.0
    if math.isnan(number):
        return 180.0
    return max(0.0, number)


def _status_payload(
    spec: UnlinkedShipmentStatusSpec,
    store_id: int,
    *,
    page: int,
    pre_page: int,
    include_export_fields: bool = False,
) -> dict[str, Any]:
    payload = {
        **spec.params,
        "store": [int(store_id)],
        "page": int(page),
        "prePage": int(pre_page),
    }
    if include_export_fields:
        payload.update(
            {
                "ids": [],
                "export_type": "1",
                "currency_type": "1",
                "entry_type": "",
            }
        )
    return payload


def _shop_options(payload: dict[str, Any]) -> list[ShopOption]:
    data = payload.get("data")
    shops = data.get("shop") if isinstance(data, dict) else None
    if not isinstance(shops, list):
        raise UnlinkedShipmentError("店铺列表数据格式异常")
    result: list[ShopOption] = []
    for item in shops:
        if not isinstance(item, dict):
            continue
        store_id = _int_value(item.get("id"))
        name = _clean_text(item.get("name"))
        if store_id is None or store_id <= 0 or not name:
            continue
        result.append(ShopOption(store_id=store_id, name=name, raw=dict(item)))
    return result


def _similar_shop_names(store_name: str, shops: list[ShopOption], *, limit: int = 5) -> list[str]:
    import difflib

    target = store_name.casefold()
    names = [shop.name for shop in shops]
    candidates: list[str] = []
    for name in names:
        folded = name.casefold()
        if target and (target in folded or folded in target):
            candidates.append(name)
    for name in difflib.get_close_matches(store_name, names, n=limit, cutoff=0.45):
        if name not in candidates:
            candidates.append(name)
    return candidates[:limit]


def pick_shop_option(store_name: str, shops: list[ShopOption]) -> ShopOption:
    clean_store_name = normalize_store_name(store_name)
    matches = [shop for shop in shops if shop.name == clean_store_name]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        ids = ", ".join(str(shop.store_id) for shop in matches)
        raise UnlinkedShipmentError(f"店铺名匹配到多个店铺: {clean_store_name}, ids={ids}")

    candidates = _similar_shop_names(clean_store_name, shops)
    suffix = f"。是否指: {', '.join(candidates)}?" if candidates else ""
    raise UnlinkedShipmentError(f"未找到店铺: {clean_store_name}{suffix}")


async def fetch_shop_options(*, token: str | None = None) -> list[ShopOption]:
    active_token = _clean_text(token) or await get_fba_free_token()
    api_url = _configured_text("FBA_SHOP_COUNTRY_API_URL", DEFAULT_SHOP_COUNTRY_URL)
    async with erp_http_session.get(
        api_url,
        params={"warehouse": "1"},
        headers=_request_headers(active_token, json_content=False),
    ) as resp:
        payload = await _read_api_json(resp, action="查询FBA店铺列表")
    return _shop_options(payload)


async def resolve_shop_option(store_name: str, *, token: str | None = None) -> ShopOption:
    return pick_shop_option(store_name, await fetch_shop_options(token=token))


def _list_total(payload: dict[str, Any]) -> int:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise UnlinkedShipmentError("未关联货件列表数据格式异常")
    total = _int_value(data.get("total"))
    if total is None or total < 0:
        raise UnlinkedShipmentError("未关联货件列表缺少有效 total")
    return total


async def fetch_status_total(
    spec: UnlinkedShipmentStatusSpec,
    store_id: int,
    *,
    token: str | None = None,
) -> int:
    active_token = _clean_text(token) or await get_fba_free_token()
    api_url = _configured_text("FBA_DELIVERY_LIST_API_URL", DEFAULT_BATCH_DELIVERY_LIST_URL)
    payload = _status_payload(spec, store_id, page=1, pre_page=1)
    async with erp_http_session.post(api_url, json=payload, headers=_request_headers(active_token)) as resp:
        response = await _read_api_json(resp, action=f"查询{spec.status_name}发货单")
    return _list_total(response)


async def create_unlinked_export_task(
    spec: UnlinkedShipmentStatusSpec,
    store_id: int,
    *,
    token: str | None = None,
    report_date: str | date | None = None,
) -> int:
    active_token = _clean_text(token) or await get_fba_free_token()
    date_text = _today_text(report_date)
    api_url = _configured_text("FBA_DELIVERY_TASK_PUSH_URL", DEFAULT_TASK_PUSH_URL)
    payload = {
        "reportEndDate": date_text,
        "reportStartDate": date_text,
        "simpleTaskConfigId": SIMPLE_TASK_CONFIG_ID,
        "reportParams": _status_payload(spec, store_id, page=1, pre_page=20, include_export_fields=True),
    }
    async with erp_http_session.post(api_url, json=payload, headers=_request_headers(active_token)) as resp:
        response = await _read_api_json(resp, action=f"创建{spec.status_name}导出任务")

    data = response.get("data")
    task_id = _int_value(data.get("taskId") if isinstance(data, dict) else None)
    if task_id is None or task_id <= 0:
        raise UnlinkedShipmentError(f"创建{spec.status_name}导出任务返回缺少 taskId")
    return task_id


def _file_suffix(file_name: str) -> str:
    suffix = Path(_clean_text(file_name)).suffix
    return suffix if suffix else ".bin"


async def download_raw_file_from_url(
    download_url: str,
    *,
    store_name: str,
    status_name: str,
    task_id: int,
    file_name: str,
    output_dir: str | Path | None = None,
    download_time: str | None = None,
) -> Path:
    url = _clean_text(download_url)
    if not url:
        raise ValueError("download_url 不能为空")

    directory = _output_dir(output_dir)
    timestamp = _timestamp_text(download_time)
    store_part = _safe_path_part(store_name, fallback="store")
    status_part = _safe_path_part(status_name, fallback="status")
    target_path = directory / f"{timestamp}-{store_part}-{status_part}-{int(task_id)}{_file_suffix(file_name)}"
    headers = {
        "Accept": "text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*"
    }
    async with external_http_session.get(url, headers=headers) as resp:
        status_code = int(getattr(resp, "status", 0) or 0)
        body = await resp.read()
        if status_code >= 400:
            msg = body.decode("utf-8", errors="replace")[:300] if body else "empty response"
            raise MabangRequestError(f"下载未关联货件原生文件失败(status={status_code}): {msg}")
        if not body:
            raise UnlinkedShipmentError("下载未关联货件原生文件返回空文件")

    target_path.write_bytes(body)
    return target_path


async def _download_status_file(
    spec: UnlinkedShipmentStatusSpec,
    *,
    store_name: str,
    store_id: int,
    token: str,
    output_dir: str | Path | None,
    timeout_sec: float,
    poll_interval_sec: float,
    report_date: str | date | None,
    download_time: str,
) -> UnlinkedShipmentStatusResult:
    total = await fetch_status_total(spec, store_id, token=token)
    if total <= 0:
        return UnlinkedShipmentStatusResult(status_name=spec.status_name, total=0)

    task_id = await create_unlinked_export_task(spec, store_id, token=token, report_date=report_date)
    task = await wait_for_delivery_task(
        task_id,
        token=token,
        timeout_sec=timeout_sec,
        poll_interval_sec=poll_interval_sec,
    )
    download_info = await request_download_info(task.task_id, task.file_hash, token=token)
    raw_path = await download_raw_file_from_url(
        download_info.download_url,
        store_name=store_name,
        status_name=spec.status_name,
        task_id=download_info.task_id,
        file_name=download_info.file_name,
        output_dir=output_dir,
        download_time=download_time,
    )
    return UnlinkedShipmentStatusResult(
        status_name=spec.status_name,
        total=total,
        task_id=download_info.task_id,
        file_hash=download_info.file_hash,
        file_name=download_info.file_name,
        raw_file_path=str(raw_path),
    )


async def download_store_unlinked_shipments(
    store_name: str,
    *,
    timeout_sec: float = 180,
    poll_interval_sec: float = 10,
    output_dir: str | Path | None = None,
    report_date: str | date | None = None,
    download_time: str | None = None,
) -> StoreUnlinkedShipmentDownloadResult:
    clean_store_name = normalize_store_name(store_name)
    token = await get_fba_free_token()
    shop = await resolve_shop_option(clean_store_name, token=token)
    safe_timeout = safe_timeout_sec(timeout_sec)
    safe_poll_interval = safe_poll_interval_sec(poll_interval_sec)
    timestamp = _timestamp_text(download_time)

    status_results: list[UnlinkedShipmentStatusResult] = []
    for spec in UNLINKED_SHIPMENT_STATUS_SPECS:
        status_results.append(
            await _download_status_file(
                spec,
                store_name=clean_store_name,
                store_id=shop.store_id,
                token=token,
                output_dir=output_dir,
                timeout_sec=safe_timeout,
                poll_interval_sec=safe_poll_interval,
                report_date=report_date,
                download_time=timestamp,
            )
        )

    return StoreUnlinkedShipmentDownloadResult(
        store_name=clean_store_name,
        store_id=shop.store_id,
        download_time=timestamp,
        status_results=status_results,
    )


__all__ = [
    "DEFAULT_OUTPUT_DIR",
    "SOURCE",
    "UNLINKED_SHIPMENT_STATUS_SPECS",
    "ShopOption",
    "StoreUnlinkedShipmentDownloadResult",
    "UnlinkedShipmentError",
    "UnlinkedShipmentStatusResult",
    "UnlinkedShipmentStatusSpec",
    "create_unlinked_export_task",
    "download_raw_file_from_url",
    "download_store_unlinked_shipments",
    "fetch_shop_options",
    "fetch_status_total",
    "normalize_store_name",
    "pick_shop_option",
    "resolve_shop_option",
    "safe_poll_interval_sec",
    "safe_timeout_sec",
]
