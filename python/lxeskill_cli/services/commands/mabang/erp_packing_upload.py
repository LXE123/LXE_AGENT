from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping


from services.commands._shared.json_cli import exception_text
from services.commands.mabang.erp_http import ERP_REQUEST_TIMEOUT_SECONDS
from services.commands.mabang.shipment_quantity_validation import (
    DELIVERY_MSKU_COLUMN,
    MSKU_SHIP_QTY_COLUMN,
    _read_delivery_rows,
    clean_cell,
    resolve_delivery_csv_path,
)
from shared.infra.cloud_client import CloudClient, CloudConnectionError, diagnostic, redact
from shared.workspace import resolve_workspace_input


MAX_RECONCILIATION_LINES = 200
MAX_REMOTE_BODY_CHARS = 4_000
PACKING_PREVIEW_SCHEMA = "lxe.erp.packing-preview.v1"
UNSHIPPED_REQUEST_PREFIX = "packing-all-unshipped-"


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
        raise PackingUploadError("packing_input_required", "预览发货单必须提供 ship_no")
    if not ship_no.startswith("SP"):
        raise PackingUploadError("invalid_ship_no", f"ship_no 格式无效: {ship_no}")
    return ship_no


def _decimal_text(value: Decimal) -> str:
    if value == value.to_integral_value():
        return str(int(value))
    return format(value.normalize(), "f").rstrip("0").rstrip(".")


def _normalized_delivery_quantities(
    path: Path, *, expected_ship_no: str | None = None,
) -> OrderedDict[str, Decimal]:
    """从发货单 CSV 读出每个 MSKU 的实发量。

    ERP 收到的仍是 {msku: 实发量}，接口和下游都不用改——换掉的只是来源。
    马帮 WMS 导出会把总量分配到错误的 MSKU 上（SP260808001 上出现过
    +176/-176 的完美抵消），发货单不会，所以 WMS 那条路已经整段移除。

    数量为 0 的行代表这个 MSKU 最终没发，不能当成装箱条目传给 ERP。
    """
    try:
        headers, rows = _read_delivery_rows(path)
    except (RuntimeError, ValueError) as exc:
        raise PackingUploadError("delivery_csv_invalid", str(exc)) from exc

    missing = [
        column for column in (DELIVERY_MSKU_COLUMN, MSKU_SHIP_QTY_COLUMN) if column not in headers
    ]
    if missing:
        raise PackingUploadError(
            "delivery_csv_invalid",
            f"发货单 CSV 缺少列: {', '.join(missing)}",
        )

    if headers.count(MSKU_SHIP_QTY_COLUMN) > 1:
        raise PackingUploadError(
            "delivery_csv_invalid",
            f"{path.name} 第1行表头重复：请只保留一列 {MSKU_SHIP_QTY_COLUMN}",
        )

    normalized_expected = str(expected_ship_no or "").strip().upper()
    quantities: dict[str, Decimal] = {}
    for index, row in enumerate(rows, start=2):
        if not any(row.values()):
            continue
        if normalized_expected:
            row_ship_no = clean_cell(row.get("发货单号")).upper()
            if row_ship_no and row_ship_no != normalized_expected:
                raise PackingUploadError(
                    "delivery_csv_invalid",
                    f"{path} 第{index}行发货单号 {row_ship_no} 与指定的 {normalized_expected} 不一致",
                )
        msku = clean_cell(row.get(DELIVERY_MSKU_COLUMN)).upper()
        if not msku:
            raise PackingUploadError(
                "delivery_csv_invalid",
                f"{path.name} 第{index}行 MSKU 为空",
            )
        raw_quantity = clean_cell(row.get(MSKU_SHIP_QTY_COLUMN))
        if not raw_quantity:
            raise PackingUploadError(
                "delivery_csv_invalid",
                f"{path.name} 第{index}行缺少 {MSKU_SHIP_QTY_COLUMN}: msku={msku}",
            )
        try:
            quantity = Decimal(raw_quantity)
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise PackingUploadError(
                "delivery_csv_invalid",
                f"{path.name} 第{index}行 {MSKU_SHIP_QTY_COLUMN} 无法解析为数字: {raw_quantity} (msku={msku})",
            ) from exc
        if not quantity.is_finite():
            raise PackingUploadError(
                "delivery_csv_invalid",
                f"{path.name} 第{index}行 {MSKU_SHIP_QTY_COLUMN} 不是有效数字: {raw_quantity} (msku={msku})",
            )
        if quantity < 0:
            raise PackingUploadError(
                "delivery_csv_invalid",
                f"{path.name} 第{index}行 {MSKU_SHIP_QTY_COLUMN} 不能小于 0: {raw_quantity} (msku={msku})",
            )
        if quantity == 0:
            continue
        quantities[msku] = quantities.get(msku, Decimal("0")) + quantity
    if not quantities:
        raise PackingUploadError(
            "delivery_csv_invalid",
            f"发货单没有任何大于 0 的 {MSKU_SHIP_QTY_COLUMN}: {path.name}",
        )
    return OrderedDict((msku, quantities[msku]) for msku in sorted(quantities))


def _resolve_delivery_source(ship_no: str, arguments: Mapping[str, Any]) -> Path:
    if "delivery_csv" in arguments:
        delivery_csv = arguments["delivery_csv"]
        if not isinstance(delivery_csv, str) or not delivery_csv.strip():
            raise PackingUploadError("delivery_csv_invalid", "--delivery-csv 需要发货单 CSV 路径")
        path = resolve_workspace_input(delivery_csv)
        if path.suffix.lower() != ".csv":
            raise PackingUploadError("delivery_csv_invalid", f"指定的发货单需要是 CSV 文件: {path}")
        try:
            return resolve_delivery_csv_path(ship_no, path)
        except FileNotFoundError as exc:
            raise PackingUploadError("delivery_csv_missing", str(exc)) from exc
    try:
        return resolve_delivery_csv_path(ship_no)
    except FileNotFoundError as exc:
        raise PackingUploadError(
            "delivery_csv_missing",
            str(exc),
            recovery={
                "next_action": "ask_user_to_download_delivery_csv",
                "skill": "mabang-delivery-data",
                "command": (
                    "lxeskill mabang delivery export "
                    f"--delivery-no {ship_no}"
                ),
            },
        ) from exc


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _captured_at(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _request_id(payload: Mapping[str, Any], *, prefix: str = "packing-") -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    digest = hashlib.sha256(canonical).hexdigest()[:32]
    return f"{prefix}{payload['sp_no']}-{digest}"


def _connection_settings() -> tuple[str, float]:
    base_url = str(os.getenv("LXE_DATA_SERVER_URL") or "").strip().rstrip("/")
    if not base_url:
        raise PackingUploadError(
            "erp_server_not_configured",
            "LXE_DATA_SERVER_URL 未配置，无法连接 ERP",
        )
    return base_url, ERP_REQUEST_TIMEOUT_SECONDS


def _safe_remote_body(response: Any) -> str:
    body = diagnostic(str(getattr(response, "text", "") or ""))
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
    return redact(dict(payload))


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
    path: str,
    *,
    base_url: str,
    timeout: float,
    json_payload: Mapping[str, Any] | None = None,
    accepted_statuses: set[int] | None = None,
) -> dict[str, Any]:
    try:
        response = CloudClient(base_url, timeout=timeout, max_response_bytes=None).request_json(
            method, path, json_body=dict(json_payload) if json_payload is not None else None,
        )
    except (CloudConnectionError, ValueError) as exc:
        raise PackingUploadError("erp_transport_error", f"连接 ERP 失败: {diagnostic(exception_text(exc))}") from exc
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
        "请核对发货单是否已记录仓库实发量。"
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


def _check_unshipped_preview(response: Mapping[str, Any]) -> None:
    if response.get("action") in {"replace", "unchanged"}:
        raise PackingUploadError(
            "packing_already_recorded",
            "该 SP 已有装箱对账。请在 FBA ERP 的当前对账详情处理整单不发。",
            detail={"sp_no": response.get("sp_no"), "batch_no": response.get("batch_no")},
        )
    summary = response.get("summary") or {}
    if (
        response.get("action") != "create"
        or response.get("reconciliation_status") not in {"passed", "mismatch"}
        or _summary_decimal(summary, "actual_quantity") != 0
    ):
        raise PackingUploadError(
            "packing_unshipped_preview_invalid",
            "ERP 未能为该 SP 生成完整的零实发对账，请核对预览明细。",
            detail={"summary": summary, "reconciliation_lines": response.get("reconciliation_lines")},
        )


def _result_with_lines(
    *,
    response: Mapping[str, Any],
    ship_no: str,
    request_id: str,
    base_url: str,
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
                f"/api/v1/erp/reconciliations/{reconciliation_id}",
                base_url=base_url,
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
    purchase_sp_no = str(response.get("sp_no") or ship_no).strip().upper()
    submitted_sp_no = str(
        response.get("submitted_sp_no") or ship_no or purchase_sp_no
    ).strip().upper()
    packing_sp_no = (
        submitted_sp_no
        if submitted_sp_no and submitted_sp_no != purchase_sp_no
        else None
    )
    return {
        "success": True,
        # ship_no remains the canonical purchase SP for existing callers.
        "ship_no": purchase_sp_no,
        "request_id": request_id,
        **dict(source or {}),
        **dict(response),
        "purchase_sp_no": purchase_sp_no,
        "packing_sp_no": packing_sp_no,
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
        base_url, timeout = _connection_settings()
        confirm_quote_id = str(
            arguments.get("confirm_packing_quote_id") or ""
        ).strip()
        all_unshipped = bool(arguments.get("all_unshipped"))
        confirm_identical = bool(arguments.get("confirm_identical"))
        if all_unshipped and (
            confirm_identical or confirm_quote_id or "delivery_csv" in arguments
        ):
            raise PackingUploadError(
                "packing_option_conflict",
                "--all-unshipped 仅用于首次预览，不能与 --delivery-csv 或 --confirm-identical 同时使用。确认该预览时单独使用 --confirm-packing-quote-id。",
            )
        if confirm_quote_id:
            if "delivery_csv" in arguments:
                raise PackingUploadError(
                    "packing_input_conflict", "--delivery-csv 用于预览，更换文件需先生成新预览",
                )
            request_id = _confirmation_request_id(confirm_quote_id)
            response = _request_json(
                "POST",
                f"/api/v1/erp/packing-snapshots/confirm",
                base_url=base_url,
                timeout=timeout,
                json_payload={
                    "request_id": request_id,
                    "quote_id": confirm_quote_id,
                },
                accepted_statuses={200, 201, 409},
            )
            # ERP echoes the original preview request ID when returning a new quote.
            if response.get("status") == "quote_stale" and str(
                response.get("request_id") or ""
            ).startswith(UNSHIPPED_REQUEST_PREFIX):
                ship_no = str(response.get("sp_no") or "")
                _check_unshipped_preview(response)
            return _result_with_lines(
                response=response,
                ship_no="",
                request_id=request_id,
                base_url=base_url,
                timeout=timeout,
            )

        if all_unshipped:
            ship_no = _normalize_ship_no(arguments.get("ship_no"))
            source_name = "人工申报：整单不发"
            declaration = f"{ship_no}\n{source_name}".encode("utf-8")
            source_sha256 = hashlib.sha256(declaration).hexdigest()
            captured_at = datetime.now(timezone.utc).isoformat()
            quantities: OrderedDict[str, Decimal] = OrderedDict()
            source = {"source_kind": "all_unshipped"}
        else:
            ship_no = _normalize_ship_no(arguments.get("ship_no"))
            source_path = _resolve_delivery_source(ship_no, arguments)
            quantities = _normalized_delivery_quantities(
                source_path, expected_ship_no=ship_no,
            )
            source_name = source_path.name
            source_sha256 = _file_sha256(source_path)
            captured_at = _captured_at(source_path)
            source = {"source_file_path": str(source_path)}
        request_body: dict[str, Any] = {
            "sp_no": ship_no,
            "source_file_name": source_name,
            "source_sha256": source_sha256,
            "captured_at": captured_at,
            "lines": [
                {"msku": msku, "actual_quantity": _decimal_text(quantity)}
                for msku, quantity in quantities.items()
            ],
        }
        request_body["request_id"] = _request_id(
            request_body, prefix=UNSHIPPED_REQUEST_PREFIX if all_unshipped else "packing-"
        )
        response = _request_json(
            "POST",
            f"/api/v1/erp/packing-snapshots/preview",
            base_url=base_url,
            timeout=timeout,
            json_payload=request_body,
            accepted_statuses={200, 409},
        )
        if all_unshipped:
            _check_unshipped_preview(response)
        else:
            _reject_identical_to_plan(response, confirm_identical=confirm_identical)
        return _result_with_lines(
            response=response,
            ship_no=ship_no,
            request_id=request_body["request_id"],
            base_url=base_url,
            timeout=timeout,
            source={
                **source,
                "source_file_name": source_name,
                "source_sha256": source_sha256,
                "captured_at": captured_at,
                "msku_count": len(quantities),
                "actual_msku_quantity": _decimal_text(
                    sum(quantities.values(), Decimal("0"))
                ),
            },
        )
    except PackingUploadError as exc:
        result = _error_payload(ship_no, exc)
        if arguments.get("all_unshipped") and exc.code in {"packing_has_manual_adjustments", "carryover_already_applied"}:
            result["recovery"] = {"message": "请打开 FBA ERP 当前对账详情，查看已生效的装箱记录。"}
        return result
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
    "_normalized_delivery_quantities",
    "_request_id",
    "run",
]
