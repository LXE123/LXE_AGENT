from __future__ import annotations

import hashlib
import json
import os
import re
from collections import OrderedDict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping

import requests

from services.agent_cli._shared.json_cli import exception_text
from services.agent_cli.mabang.erp_http import ERP_REQUEST_TIMEOUT_SECONDS
from services.agent_cli.mabang.shipment_quantity_validation import (
    read_consignment_msku_quantities,
    read_delivery_msku_infos,
    resolve_delivery_csv_path,
)
from services.mabang.amazon.fba.consignment_excel import (
    resolve_consignment_excel_dir,
)
from shared.infra.net import local_service_requests_session


MAX_RECONCILIATION_LINES = 200
MAX_REMOTE_BODY_CHARS = 4_000
PACKING_PREVIEW_SCHEMA = "lxe.erp.packing-preview.v1"
PACKING_EXTENSIONS = {".xls", ".xlsx"}
SOURCE_WMS = "wms"
SOURCE_DELIVERY = "delivery"
PACKING_SOURCES = {SOURCE_WMS, SOURCE_DELIVERY}


class PackingUploadError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int | None = None,
        detail: Mapping[str, Any] | None = None,
        recovery: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.http_status = http_status
        self.detail = dict(detail or {})
        self.recovery = dict(recovery or {})


def _normalize_ship_no(value: Any) -> str:
    ship_no = str(value or "").strip().upper()
    if not ship_no:
        raise PackingUploadError("invalid_ship_no", "ship_no 不能为空")
    if not ship_no.startswith("SP"):
        raise PackingUploadError("invalid_ship_no", f"ship_no 格式无效: {ship_no}")
    return ship_no


def _find_original_packing_file(ship_no: str) -> Path:
    directory = resolve_consignment_excel_dir()
    candidates = [
        path
        for path in (
            directory / f"{ship_no}.xls",
            directory / f"{ship_no}.xlsx",
        )
        if path.is_file()
    ]
    if not candidates:
        candidates = [
            path
            for path in (
                directory / f"{ship_no.lower()}.xls",
                directory / f"{ship_no.lower()}.xlsx",
            )
            if path.is_file()
        ]
    if not candidates:
        command = (
            "lxeskill fba shipment wms-box-download "
            f"--ship-no {ship_no} --split-mode original"
        )
        raise PackingUploadError(
            "packing_file_missing",
            f"未找到原始 WMS 装箱文件: {ship_no} (目录: {directory})",
            recovery={
                "next_action": "ask_user_to_download_original_wms",
                "skill": "fba-shipment-wms-box-download",
                "command": command,
            },
        )
    return max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name))


def _direct_packing_file(value: Any, ship_no: str) -> tuple[Path, str]:
    path = Path(str(value or "").strip()).expanduser()
    if not str(path):
        raise PackingUploadError("packing_file_missing", "packing_excel 不能为空")
    if not path.is_file():
        raise PackingUploadError(
            "packing_file_missing",
            f"装箱附件不存在或不是文件: {path}",
        )
    if path.suffix.lower() not in PACKING_EXTENSIONS:
        raise PackingUploadError(
            "packing_file_extension_unsupported",
            f"装箱附件仅支持 .xls 或 .xlsx: {path.name}",
        )
    file_ship_no = path.stem.strip().upper()
    if not re.fullmatch(r"SP[0-9]+", file_ship_no):
        raise PackingUploadError(
            "packing_file_not_original",
            f"只允许上传以完整 SP 号命名的原始装箱文件: {path.name}",
        )
    if ship_no and ship_no != file_ship_no:
        raise PackingUploadError(
            "packing_file_ship_no_mismatch",
            f"ship_no 与装箱附件文件名不一致: {ship_no} != {file_ship_no}",
        )
    return path.resolve(), file_ship_no


def _resolve_source(arguments: Mapping[str, Any]) -> tuple[Path, str]:
    raw_ship_no = str(arguments.get("ship_no") or "").strip()
    ship_no = _normalize_ship_no(raw_ship_no) if raw_ship_no else ""
    packing_excel = str(arguments.get("packing_excel") or "").strip()
    if packing_excel:
        return _direct_packing_file(packing_excel, ship_no)
    if not ship_no:
        raise PackingUploadError(
            "packing_input_required",
            "必须提供 packing_excel 附件路径或 ship_no",
        )
    return _find_original_packing_file(ship_no), ship_no


def _decimal_text(value: Decimal) -> str:
    if value == value.to_integral_value():
        return str(int(value))
    return format(value.normalize(), "f").rstrip("0").rstrip(".")


def _normalized_msku_quantities(path: Path) -> OrderedDict[str, Decimal]:
    parsed = read_consignment_msku_quantities(path)
    normalized: dict[str, Decimal] = {}
    for raw_msku, quantity in parsed.items():
        msku = str(raw_msku or "").strip().upper()
        if not msku:
            raise PackingUploadError(
                "packing_file_invalid",
                f"装箱数据包含空 MSKU: {path.name}",
            )
        normalized[msku] = normalized.get(msku, Decimal("0")) + quantity
    return OrderedDict((msku, normalized[msku]) for msku in sorted(normalized))



def _normalized_delivery_quantities(path: Path) -> OrderedDict[str, Decimal]:
    """从发货单 CSV 读出每个 MSKU 的实发量。

    形状和 _normalized_msku_quantities 完全一致，所以 ERP 请求体、接口和下游
    都不用改——换的只是这批数字的来源：马帮 WMS 导出会把总量分配到错误的
    MSKU 上（SP260808001 上出现过 +176/-176 的完美抵消），发货单不会。

    数量为 0 的行代表这个 MSKU 最终没发，不能当成装箱条目传给 ERP。
    """
    infos = read_delivery_msku_infos(path)
    quantities: dict[str, Decimal] = {}
    for raw_msku, info in infos.items():
        msku = str(raw_msku or "").strip().upper()
        if not msku:
            raise PackingUploadError(
                "delivery_csv_invalid",
                f"发货单包含空 MSKU: {path.name}",
            )
        quantity = info.msku_ship_quantity
        if quantity is None:
            raise PackingUploadError(
                "delivery_csv_invalid",
                f"发货单缺少 MSKU发货量: msku={msku}, file={path.name}",
            )
        if quantity <= 0:
            continue
        quantities[msku] = quantities.get(msku, Decimal("0")) + quantity
    if not quantities:
        raise PackingUploadError(
            "delivery_csv_invalid",
            f"发货单没有任何大于 0 的 MSKU发货量: {path.name}",
        )
    return OrderedDict((msku, quantities[msku]) for msku in sorted(quantities))


def _resolve_packing_source(arguments: Mapping[str, Any]) -> str:
    source = str(arguments.get("source") or SOURCE_WMS).strip().lower()
    if source not in PACKING_SOURCES:
        raise PackingUploadError(
            "packing_source_invalid",
            f"source 只支持 {sorted(PACKING_SOURCES)}: {source}",
        )
    return source


def _resolve_delivery_source(arguments: Mapping[str, Any]) -> tuple[Path, str]:
    raw_ship_no = str(arguments.get("ship_no") or "").strip()
    if not raw_ship_no:
        raise PackingUploadError(
            "packing_input_required",
            "source=delivery 时必须提供 ship_no",
        )
    ship_no = _normalize_ship_no(raw_ship_no)
    try:
        path = resolve_delivery_csv_path(ship_no)
    except FileNotFoundError as exc:
        raise PackingUploadError(
            "delivery_csv_missing",
            str(exc),
            recovery={
                "next_action": "ask_user_to_download_delivery_csv",
                "skill": "fba-shipment-delivery-csv-download",
                "command": (
                    "lxeskill fba shipment delivery-csv-download "
                    f"--delivery-no {ship_no}"
                ),
            },
        ) from exc
    return path, ship_no


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _captured_at(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _request_id(payload: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()[:32]
    return f"packing-{payload['sp_no']}-{digest}"


def _connection_settings() -> tuple[str, str, float]:
    base_url = str(os.getenv("LXE_DATA_SERVER_URL") or "").strip().rstrip("/")
    if not base_url:
        raise PackingUploadError(
            "erp_server_not_configured",
            "LXE_DATA_SERVER_URL 未配置，无法连接 ERP",
        )
    api_key = str(os.getenv("LXE_ERP_API_KEY") or "").strip()
    if not api_key:
        raise PackingUploadError(
            "erp_credentials_not_configured",
            "LXE_ERP_API_KEY 未配置，无法上传真实发货量",
        )
    return base_url, api_key, ERP_REQUEST_TIMEOUT_SECONDS


def _safe_remote_body(response: Any) -> str:
    body = str(getattr(response, "text", "") or "")
    if len(body) <= MAX_REMOTE_BODY_CHARS:
        return body
    omitted = len(body) - MAX_REMOTE_BODY_CHARS
    return f"{body[:MAX_REMOTE_BODY_CHARS]}... [truncated {omitted} chars]"


def _response_json(response: Any) -> dict[str, Any]:
    try:
        payload = response.json()
    except Exception as exc:
        body = _safe_remote_body(response)
        raise PackingUploadError(
            "erp_response_invalid",
            f"ERP 返回了无法解析的 JSON: HTTP {response.status_code}, body={body}",
            http_status=int(response.status_code),
        ) from exc
    if not isinstance(payload, dict):
        raise PackingUploadError(
            "erp_response_invalid",
            f"ERP 返回 JSON 不是对象: HTTP {response.status_code}",
            http_status=int(response.status_code),
        )
    return dict(payload)


def _raise_remote_error(response: Any, payload: Mapping[str, Any]) -> None:
    raw_detail = payload.get("detail")
    detail = dict(raw_detail) if isinstance(raw_detail, dict) else {}
    code = str(detail.get("code") or f"erp_http_{response.status_code}")
    message = str(
        detail.get("message")
        or raw_detail
        or _safe_remote_body(response)
        or f"ERP 请求失败: HTTP {response.status_code}"
    )
    raise PackingUploadError(
        code,
        message,
        http_status=int(response.status_code),
        detail=detail,
    )


def _request_json(
    method: str,
    url: str,
    *,
    api_key: str,
    timeout: float,
    json_payload: Mapping[str, Any] | None = None,
    accepted_statuses: set[int] | None = None,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    try:
        response = local_service_requests_session.request(
            method,
            url,
            headers=headers,
            json=dict(json_payload) if json_payload is not None else None,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        raise PackingUploadError(
            "erp_transport_error",
            f"连接 ERP 失败: {exception_text(exc)}",
        ) from exc
    payload = _response_json(response)
    status_code = int(response.status_code)
    accepted = (
        status_code in accepted_statuses
        if accepted_statuses is not None
        else 200 <= status_code < 300
    )
    if not accepted or (status_code >= 400 and "detail" in payload):
        _raise_remote_error(response, payload)
    return payload


def _error_payload(ship_no: str, exc: PackingUploadError) -> dict[str, Any]:
    error: dict[str, Any] = {
        "code": exc.code,
        "message": str(exc),
    }
    if exc.http_status is not None:
        error["http_status"] = exc.http_status
    if exc.detail:
        error["detail"] = exc.detail
    result: dict[str, Any] = {
        "success": False,
        "ship_no": ship_no,
        "exception": str(exc),
        "error": error,
    }
    if exc.recovery:
        result["recovery"] = exc.recovery
    return result


def _summary_decimal(summary: Mapping[str, Any], field: str) -> Decimal | None:
    raw = summary.get(field)
    if raw is None or str(raw).strip() == "":
        return None
    try:
        return Decimal(str(raw))
    except (InvalidOperation, ValueError):
        return None


def _reject_identical_to_plan(
    payload: Mapping[str, Any],
    *,
    confirm_identical: bool,
) -> None:
    """实际量和计划量逐个 SKU 完全一致时拒绝上传。

    马帮尚未回填装箱数据时，发货单上的数量还是计划值，这时上传只会写进一份
    没有信息量的快照。差异为 0 也可能是仓库如实发货，所以给 confirm_identical
    留一条明确的出路，而不是把门焊死。

    判据必须同时看差异和留存：差异是净值，+176 和 -176 会互相抵消（这在
    SP260808001 上真实发生过），只有留存也为 0 才说明没有任何一个 SKU 短发。
    """
    if confirm_identical:
        return
    summary = payload.get("summary")
    if not isinstance(summary, Mapping):
        return
    difference = _summary_decimal(summary, "difference_quantity")
    carryover = _summary_decimal(summary, "carryover_quantity")
    planned = _summary_decimal(summary, "planned_quantity")
    if difference is None or carryover is None or planned is None:
        return
    if difference != 0 or carryover != 0 or planned <= 0:
        return
    raise PackingUploadError(
        "packing_identical_to_plan",
        "实际发货量与计划完全一致（计划 "
        f"{_decimal_text(planned)}，差异 0，留存 0）。"
        "这通常表示马帮尚未回填真实装箱数据，此时上传不会产生任何对账信息。"
        "若确认仓库确实按计划如数发货，请追加 --confirm-identical 重跑。",
    )


def _validate_server_response(payload: Mapping[str, Any]) -> str:
    status = str(payload.get("status") or "").strip()
    if payload.get("response_schema") != PACKING_PREVIEW_SCHEMA:
        raise PackingUploadError(
            "erp_response_invalid",
            "ERP 装箱响应缺少受支持的 response_schema",
        )
    if status not in {
        "confirmation_required",
        "quote_stale",
        "created",
        "unchanged",
        "idempotent",
    }:
        raise PackingUploadError(
            "erp_response_invalid",
            f"ERP 装箱响应状态无效: {status or '<empty>'}",
        )
    return status


def _confirmation_request_id(quote_id: str) -> str:
    digest = hashlib.sha256(quote_id.encode("utf-8")).hexdigest()[:32]
    return f"packing-confirm-{digest}"


def _result_with_lines(
    *,
    response: Mapping[str, Any],
    ship_no: str,
    request_id: str,
    base_url: str,
    api_key: str,
    timeout: float,
    source: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    status = _validate_server_response(response)
    raw_lines = response.get("reconciliation_lines")
    reconciliation_lines = (
        [dict(item) for item in raw_lines if isinstance(item, dict)]
        if isinstance(raw_lines, list)
        else []
    )
    detail_error: dict[str, Any] | None = None
    reconciliation_id = str(response.get("reconciliation_id") or "").strip()
    if not reconciliation_lines and reconciliation_id and status in {
        "created",
        "idempotent",
        "unchanged",
    }:
        try:
            detail = _request_json(
                "GET",
                f"{base_url}/api/v1/erp/reconciliations/{reconciliation_id}",
                api_key=api_key,
                timeout=timeout,
            )
            detail_lines = detail.get("lines")
            if isinstance(detail_lines, list):
                reconciliation_lines = [
                    dict(item) for item in detail_lines if isinstance(item, dict)
                ]
        except PackingUploadError as exc:
            detail_error = {
                "code": exc.code,
                "message": str(exc),
                **(
                    {"http_status": exc.http_status}
                    if exc.http_status is not None
                    else {}
                ),
            }
    returned_lines = reconciliation_lines[:MAX_RECONCILIATION_LINES]
    truncated_count = max(0, len(reconciliation_lines) - len(returned_lines))
    reconciliation_status = str(response.get("reconciliation_status") or "")
    return {
        "success": True,
        "ship_no": str(response.get("sp_no") or ship_no),
        "request_id": request_id,
        **dict(source or {}),
        **dict(response),
        "reconciliation_lines": returned_lines,
        "reconciliation_line_count": len(reconciliation_lines),
        "reconciliation_lines_truncated": truncated_count,
        "reconciliation_detail_error": detail_error,
        "confirmation_required": status in {"confirmation_required", "quote_stale"},
        "needs_attention": (
            reconciliation_status in {"mismatch", "incomplete"}
            or detail_error is not None
        ),
    }


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    ship_no = ""
    try:
        base_url, api_key, timeout = _connection_settings()
        confirm_quote_id = str(
            arguments.get("confirm_packing_quote_id") or ""
        ).strip()
        if confirm_quote_id:
            request_id = _confirmation_request_id(confirm_quote_id)
            response = _request_json(
                "POST",
                f"{base_url}/api/v1/erp/packing-snapshots/confirm",
                api_key=api_key,
                timeout=timeout,
                json_payload={
                    "request_id": request_id,
                    "quote_id": confirm_quote_id,
                },
                accepted_statuses={200, 201, 409},
            )
            return _result_with_lines(
                response=response,
                ship_no="",
                request_id=request_id,
                base_url=base_url,
                api_key=api_key,
                timeout=timeout,
            )

        confirm_identical = bool(arguments.get("confirm_identical"))
        packing_source = _resolve_packing_source(arguments)
        if packing_source == SOURCE_DELIVERY:
            source_path, ship_no = _resolve_delivery_source(arguments)
            quantities = _normalized_delivery_quantities(source_path)
        else:
            source_path, ship_no = _resolve_source(arguments)
            quantities = _normalized_msku_quantities(source_path)
        source_sha256 = _file_sha256(source_path)
        captured_at = _captured_at(source_path)
        request_body: dict[str, Any] = {
            "sp_no": ship_no,
            "source_file_name": source_path.name,
            "source_sha256": source_sha256,
            "captured_at": captured_at,
            "lines": [
                {"msku": msku, "actual_quantity": _decimal_text(quantity)}
                for msku, quantity in quantities.items()
            ],
        }
        request_body["request_id"] = _request_id(request_body)
        response = _request_json(
            "POST",
            f"{base_url}/api/v1/erp/packing-snapshots/preview",
            api_key=api_key,
            timeout=timeout,
            json_payload=request_body,
            accepted_statuses={200, 409},
        )
        _reject_identical_to_plan(response, confirm_identical=confirm_identical)
        return _result_with_lines(
            response=response,
            ship_no=ship_no,
            request_id=request_body["request_id"],
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            source={
                "source_file_path": str(source_path),
                "source_file_name": source_path.name,
                "source_sha256": source_sha256,
                "captured_at": captured_at,
                "packing_source": packing_source,
                "msku_count": len(quantities),
                "actual_msku_quantity": _decimal_text(
                    sum(quantities.values(), Decimal("0"))
                ),
            },
        )
    except PackingUploadError as exc:
        return _error_payload(ship_no, exc)
    except Exception as exc:  # noqa: BLE001 - preserve the real parsing/file error
        message = exception_text(exc)
        return {
            "success": False,
            "ship_no": ship_no,
            "exception": message,
            "error": {"code": "packing_upload_failed", "message": message},
        }


__all__ = [
    "PackingUploadError",
    "_direct_packing_file",
    "_find_original_packing_file",
    "_request_id",
    "run",
]
