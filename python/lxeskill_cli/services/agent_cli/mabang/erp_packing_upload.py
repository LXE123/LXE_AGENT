from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

import requests

from services.agent_cli._shared.json_cli import exception_text
from services.agent_cli.mabang.shipment_quantity_validation import (
    read_consignment_msku_quantities,
)
from services.mabang.amazon.fba.consignment_excel import (
    resolve_consignment_excel_dir,
)
from shared.infra.net import local_service_requests_session


MAX_RECONCILIATION_LINES = 200
MAX_REMOTE_BODY_CHARS = 4_000
DEFAULT_TIMEOUT_SECONDS = 30.0


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


def _timeout_seconds() -> float:
    raw = str(os.getenv("LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS") or "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError as exc:
        raise PackingUploadError(
            "erp_environment_invalid",
            f"LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS 格式无效: {raw}",
        ) from exc
    if value <= 0:
        raise PackingUploadError(
            "erp_environment_invalid",
            "LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS 必须大于 0",
        )
    return value


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
    return base_url, api_key, _timeout_seconds()


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
    if not 200 <= int(response.status_code) < 300:
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


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    ship_no = ""
    try:
        ship_no = _normalize_ship_no(arguments.get("ship_no"))
        confirm_snapshot_id = str(
            arguments.get("confirm_replace_snapshot_id") or ""
        ).strip()
        source_path = _find_original_packing_file(ship_no)
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
        if confirm_snapshot_id:
            request_body["confirm_replace_snapshot_id"] = confirm_snapshot_id
        request_body["request_id"] = _request_id(request_body)

        base_url, api_key, timeout = _connection_settings()
        upload = _request_json(
            "POST",
            f"{base_url}/api/v1/erp/packing-snapshots/import",
            api_key=api_key,
            timeout=timeout,
            json_payload=request_body,
        )

        reconciliation_lines: list[dict[str, Any]] = []
        detail_error: dict[str, Any] | None = None
        reconciliation_id = str(upload.get("reconciliation_id") or "").strip()
        if reconciliation_id:
            try:
                detail = _request_json(
                    "GET",
                    f"{base_url}/api/v1/erp/reconciliations/{reconciliation_id}",
                    api_key=api_key,
                    timeout=timeout,
                )
                raw_lines = detail.get("lines")
                if isinstance(raw_lines, list):
                    reconciliation_lines = [
                        dict(item) for item in raw_lines if isinstance(item, dict)
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
        reconciliation_status = str(upload.get("reconciliation_status") or "")
        return {
            "success": True,
            "ship_no": ship_no,
            "source_file_path": str(source_path.resolve()),
            "source_file_name": source_path.name,
            "source_sha256": source_sha256,
            "captured_at": captured_at,
            "request_id": request_body["request_id"],
            "msku_count": len(quantities),
            "actual_msku_quantity": _decimal_text(sum(quantities.values(), Decimal("0"))),
            **upload,
            "reconciliation_lines": returned_lines,
            "reconciliation_line_count": len(reconciliation_lines),
            "reconciliation_lines_truncated": truncated_count,
            "reconciliation_detail_error": detail_error,
            "needs_attention": (
                reconciliation_status in {"mismatch", "incomplete"}
                or detail_error is not None
            ),
        }
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
    "_find_original_packing_file",
    "_request_id",
    "run",
]
