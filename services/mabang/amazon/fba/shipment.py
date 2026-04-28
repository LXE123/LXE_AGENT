from __future__ import annotations

import re
from typing import Any

from shared.config import config
from shared.infra.net import erp_http_session
from shared.logging import logger

from ...auth import get_fba_free_token
from ...errors import MabangAuthError, MabangBusinessError, MabangRequestError

DEFAULT_API_URL = "https://api-private.mabangerp.com/fba/api/v1/fbaShipment/getShipmentNewList"
DEFAULT_ORIGIN = "https://amz1-private.mabangerp.com"
DEFAULT_REFERER = "https://amz1-private.mabangerp.com/"
DEFAULT_SHIPMENT_STATUS = [
    "WORKING",
    "READY_TO_SHIP",
    "IN_TRANSIT",
    "SHIPPED",
    "RECEIVING",
    "CHECKED_IN",
    "DELIVERED",
]
DEFAULT_STATUS_FILTER = [1, 2, 3]
AUTH_FAIL_STATUS = {401, 403}
SUFFIX_GROUP_PATTERN = re.compile(r"^(?P<prefix>[A-Z0-9]+?)U\d+$")


class ShipmentApiError(MabangBusinessError):
    pass


class ShipmentApiAuthError(ShipmentApiError, MabangAuthError):
    pass


def _authorization_value(token: str) -> str:
    text = str(token or "").strip()
    if not text:
        return ""
    if text.lower().startswith("bearer "):
        return text
    return f"Bearer {text}"


def _request_payload(shipp_no: str) -> dict[str, Any]:
    return {
        "page": 1,
        "prePage": 10,
        "shipmentStatus": DEFAULT_SHIPMENT_STATUS,
        "status": DEFAULT_STATUS_FILTER,
        "shippNO": shipp_no,
    }


def _normalize_shipp_no_for_query(shipp_no: str) -> str:
    raw = str(shipp_no or "").strip().upper()
    if not raw:
        return ""
    match = SUFFIX_GROUP_PATTERN.match(raw)
    if not match:
        return raw
    return str(match.group("prefix") or "").strip()


def _request_headers(token: str) -> dict[str, str]:
    origin = str(getattr(config, "FBA_LOGISTICS_SHIPMENT_API_ORIGIN", DEFAULT_ORIGIN) or DEFAULT_ORIGIN).strip()
    referer = str(
        getattr(config, "FBA_LOGISTICS_SHIPMENT_API_REFERER", DEFAULT_REFERER) or DEFAULT_REFERER
    ).strip()
    return {
        "Authorization": _authorization_value(token),
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "ProjectId": "erp",
        "Origin": origin,
        "Referer": referer,
    }


def _pick_row(payload: dict[str, Any], shipp_no: str) -> dict[str, Any]:
    data = payload.get("data")
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list) or not rows:
        raise ShipmentApiError(f"未查询到货件信息: shippNo={shipp_no}")

    target = str(shipp_no or "").strip().upper()
    if target:
        for row in rows:
            if not isinstance(row, dict):
                continue
            current = str(row.get("shippNo") or "").strip().upper()
            if current == target:
                return row
    first = rows[0]
    if not isinstance(first, dict):
        raise ShipmentApiError("货件数据格式异常")
    return first


def _normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    site_code = str(row.get("amazonsiteCode") or "").strip().upper()
    return {
        "shipment_no": str(row.get("shippNo") or "").strip(),
        "warehouse": str(row.get("warehouse") or "").strip(),
        "address": str(row.get("fbaWarehouseAddress") or "").strip(),
        "amazonsite_code": site_code,
        "shipment_status": str(row.get("ShipmentStatus") or "").strip(),
        "raw": row,
    }


async def _request_once(shipp_no: str, token: str) -> dict[str, Any]:
    api_url = str(getattr(config, "FBA_LOGISTICS_SHIPMENT_API_URL", DEFAULT_API_URL) or DEFAULT_API_URL).strip()
    payload = _request_payload(shipp_no)
    headers = _request_headers(token)
    async with erp_http_session.post(api_url, json=payload, headers=headers) as resp:
        status_code = int(resp.status)
        text = await resp.text()
        try:
            data = await resp.json(content_type=None)
        except Exception:
            data = None

        if status_code in AUTH_FAIL_STATUS:
            raise ShipmentApiAuthError(f"API 鉴权失败(status={status_code})")

        if status_code >= 400:
            msg = text[:300] if text else "empty response"
            raise MabangRequestError(f"API 请求失败(status={status_code}): {msg}")

        if not isinstance(data, dict):
            raise ShipmentApiError("API 返回?JSON 对象")

        code = data.get("code")
        if code != 200:
            msg = str(data.get("msg") or "unknown")
            if str(code) in {"401", "403"}:
                raise ShipmentApiAuthError(f"API 鉴权失败(code={code}, msg={msg})")
            raise ShipmentApiError(f"API 业务异常(code={code}, msg={msg})")
        return data


async def get_shipment_api_token() -> str:
    return await get_fba_free_token()


async def fetch_shipment_address_by_shipp_no(shipp_no: str, token: str | None = None) -> dict[str, Any]:
    target_no = str(shipp_no or "").strip().upper()
    if not target_no:
        raise ValueError("shipp_no 不能为空")
    query_no = _normalize_shipp_no_for_query(target_no)
    if not query_no:
        raise ValueError("shipp_no 不能为空")
    if query_no != target_no:
        logger.info(
            f"[FBA Logistics][ShipmentAPI] 使用分组货件号查 original={target_no}, query={query_no}"
        )

    active_token = str(token or "").strip()
    if not active_token:
        active_token = await get_shipment_api_token()
    payload = await _request_once(query_no, active_token)

    row = _pick_row(payload, target_no)
    normalized = _normalize_row(row)
    if not normalized["warehouse"] or not normalized["address"]:
        raise ShipmentApiError("货件信息缺少 warehouse ?fbaWarehouseAddress")
    return normalized
