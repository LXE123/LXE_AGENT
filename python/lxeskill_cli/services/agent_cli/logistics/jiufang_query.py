"""One anonymous Jiufang query, with auditable box-ID normalization.

This fixed public HTTP endpoint was verified without cookies or authentication
on 2026-10-16. This adapter does not control a browser or access session state.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import re
import time
from typing import Any

import requests

from services.agent_cli.logistics.common import diagnostic, safe_output

URL = "https://www.jiufanglogistics.cn/test-api/seaair/waybills/selectWaybillStatusByWaybillNo"
MAX_BYTES = 2 * 1024 * 1024
FBA_PATTERN = re.compile(r"FBA[A-Z0-9]{7,}")
BOX_PATTERN = re.compile(r"(FBA[A-Z0-9]{7,})(U[0-9]{6})")
ROW_FIELDS = ("volume", "referenceNo", "trackNumber", "loadingPort", "shipmentId",
              "destination", "weight", "shippingWay", "waybillNo", "packageNum")
LINE_FIELDS = ("status", "content", "operationDateTime", "remark", "state")


def normalize_identifier(raw: str, kind: str = "auto") -> dict[str, Any]:
    if not isinstance(raw, str):
        raise ValueError("fba must be a string")
    value = raw.strip()
    if len(value) > 64 or not FBA_PATTERN.fullmatch(value):
        raise ValueError("fba must be one uppercase FBA identifier, optionally ending in U + six box digits")
    if kind not in {"auto", "shipment", "box"}:
        raise ValueError("identifier_kind must be auto, shipment or box")
    box = BOX_PATTERN.fullmatch(value) if kind != "shipment" else None
    if kind == "box" and box is None:
        raise ValueError("box identifier must end in the observed U + six digits layout")
    return {"input_fba": raw, "fba": box[1] if box else value,
            "box_suffix": box[2] if box else None, "identifier_kind": kind,
            "normalization_rule": "terminal_U_six_digits" if box else "unchanged",
            "identity_verified": False}


def _validate(arguments: dict[str, Any]) -> dict[str, Any]:
    unknown = set(arguments) - {"fba", "expected_warehouse", "identifier_kind"}
    if unknown:
        raise ValueError("Unknown arguments: " + ", ".join(sorted(unknown)))
    normalized = normalize_identifier(arguments.get("fba"), arguments.get("identifier_kind", "auto"))
    warehouse = arguments.get("expected_warehouse", "")
    if not isinstance(warehouse, str) or (warehouse and not re.fullmatch(r"[A-Z0-9]{2,12}", warehouse)):
        raise ValueError("expected_warehouse must be an uppercase warehouse code")
    return {**normalized, "expected_warehouse": warehouse}


def _read_public(fba: str) -> tuple[int, str, bytes]:
    # A fresh session with trust_env=False also prevents implicit .netrc auth.
    # No Cookie, Authorization, browser state, account config or caller URL.
    with requests.Session() as session:
        session.trust_env = False
        deadline = time.monotonic() + 40
        with session.post(URL, json=[fba], timeout=(10, 30), stream=True,
                          allow_redirects=False) as response:
            chunks = []
            size = 0
            for chunk in response.iter_content(chunk_size=65536):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError(f"Response exceeded {MAX_BYTES} bytes [truncated]")
                if time.monotonic() > deadline:
                    raise TimeoutError("Public query response exceeded 40 seconds")
                chunks.append(chunk)
            return response.status_code, response.headers.get("Content-Type", ""), b"".join(chunks)


def parse_result(payload: Any, arguments: dict[str, Any], http_status: int = 200) -> dict[str, Any]:
    result: dict[str, Any] = {
        "success": False, "request_succeeded": False, "found": False,
        "matched_count": 0, "matches": [], "complete": False,
        "http_status": http_status, "identity_verified": False,
        "provider_code": payload.get("code") if isinstance(payload, dict) else None,
        "provider_message": diagnostic(payload.get("message")) if isinstance(payload, dict) else "",
    }

    def fail(code: str, message: Any) -> dict[str, Any]:
        result["error"] = {"code": code, "message": diagnostic(message)}
        return result

    if type(http_status) is not int or not 200 <= http_status < 300:
        return fail("http_error", f"HTTP {http_status}: " + diagnostic(payload))
    if not isinstance(payload, dict):
        return fail("invalid_response", "Expected response object; observed " + diagnostic(payload))
    if type(payload.get("code")) is not int or payload["code"] != 200:
        return fail("provider_error", {"code": payload.get("code"), "message": payload.get("message")})
    rows = payload.get("data")
    result["provider_unmatched"] = diagnostic(payload.get("data2"))
    if not isinstance(rows, list):
        return fail("invalid_rows", "Expected data array; observed " + diagnostic(rows))
    if len(rows) > 100:
        return fail("response_too_large", f"data contains {len(rows)} rows; maximum 100 [truncated]")
    if not rows:
        # A true empty response has not been captured; don't invent its meaning.
        result["request_succeeded"] = True
        return fail("empty_result_unverified", {"code": payload["code"], "message": payload.get("message"),
                                               "data": rows, "data2": payload.get("data2")})
    matches = []
    for row in rows:
        if not isinstance(row, dict):
            return fail("invalid_row", "Expected row object; observed " + diagnostic(row))
        for key in ROW_FIELDS:
            value = row.get(key)
            if key in {"volume", "weight", "loadingPort", "packageNum"}:
                if value is not None and (type(value) not in {int, float} or not math.isfinite(value) or value < 0):
                    return fail("invalid_row", f"Invalid {key}: " + diagnostic(value))
                if key == "packageNum" and value is not None and type(value) is not int:
                    return fail("invalid_row", "Invalid packageNum: " + diagnostic(value))
            elif value is not None and (not isinstance(value, str) or len(value) > 8000):
                return fail("invalid_row", f"Invalid/oversized {key}: " + diagnostic(value))
        raw_ids = row.get("shipmentId")
        if not isinstance(raw_ids, str):
            return fail("invalid_identity", "Missing shipmentId: " + diagnostic(raw_ids))
        ids = [part.strip() for part in raw_ids.split(",")]
        if not ids or any(len(part) > 64 or not FBA_PATTERN.fullmatch(part) for part in ids):
            return fail("invalid_identity", "Unrecognized shipmentId layout: " + diagnostic(raw_ids))
        if arguments["fba"] not in ids:
            return fail("identity_mismatch", f"Requested {arguments['fba']}; response shipmentId={raw_ids}")
        lines = row.get("lines")
        if not isinstance(lines, list) or len(lines) > 200:
            return fail("invalid_traces", "Expected at most 200 lines; observed " + diagnostic(lines))
        for line in lines:
            if not isinstance(line, dict) or type(line.get("status")) is not int or type(line.get("state")) is not bool:
                return fail("invalid_trace", "Invalid status/state: " + diagnostic(line))
            for key in ("content", "operationDateTime", "remark"):
                value = line.get(key)
                if (key == "content" and not isinstance(value, str)) or (
                    value is not None and (not isinstance(value, str) or len(value) > 8000)
                ):
                    return fail("invalid_trace", f"Invalid/oversized {key}: " + diagnostic(value))
        destination = row.get("destination") or ""
        warehouse_match = re.fullmatch(r"(.+)-FBA-([A-Z0-9]{2,12})", destination)
        warehouse = warehouse_match[2] if warehouse_match else None
        expected = arguments.get("expected_warehouse")
        warnings = ["eta_unavailable; port/warehouse stages are not final-delivery estimates",
                    "trace_timezone_unspecified; preserve provider time text",
                    "carrier_unavailable; do not infer from numbers or shippingWay",
                    "parcel_count_and_weight_scope_is_entire_waybill"]
        if len(ids) > 1:
            warnings.append("shared_waybill; totals cannot be allocated to an individual FBA")
        if row.get("trackNumber"):
            warnings.append("tracking_layout_unverified; retain raw trackNumber")
        if expected and warehouse is None:
            warnings.append("expected_warehouse_not_verified")
        elif expected and expected != warehouse:
            warnings.append("warehouse_mismatch")
        delivered = any(line["status"] == 140 and line["state"] is True
                        and line["content"] == "已签收(结)" for line in lines)
        missing = [key for key, value in (("shipment_number", row.get("waybillNo")),
                   ("warehouse", warehouse), ("carrier", None), ("tracking_numbers", None), ("eta", None)) if not value]
        matches.append({
            "fba_numbers": ids, "shipment_number": row.get("waybillNo") or "",
            "reference_number": row.get("referenceNo") or "", "destination": destination,
            "warehouse": warehouse, "warehouse_matches": warehouse == expected if expected and warehouse else None,
            "carrier": None, "tracking_numbers": [], "eta": None,
            "shipment_status": "delivered" if delivered else "", "shipping_way": row.get("shippingWay"),
            "parcel_count": row.get("packageNum"), "weight": row.get("weight"), "volume": row.get("volume"),
            "totals_scope": "waybill", "trace_timezone": None,
            "traces": [{key: line.get(key) for key in LINE_FIELDS} for line in lines],
            "source_fields": {key: row[key] for key in ROW_FIELDS if key in row},
            "warnings": warnings, "missing_fields": missing,
        })
    warnings = sorted({warning for match in matches for warning in match["warnings"]})
    if len(matches) > 1:
        warnings.append("multiple_matching_waybills; preserve all matches")
    result.update(success=True, request_succeeded=True, found=True, complete=True,
                  identity_verified=True, matched_count=len(matches), matches=matches, warnings=warnings)
    return result


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"success": False, "provider": "jiufang", "auth_refresh_required": False,
        "request_attempted": False, "request_succeeded": False, "found": False,
        "matches": [], "complete": False, "identity_verified": False}
    try:
        args = _validate(arguments)
        result.update(args, queried_at=datetime.now(timezone.utc).isoformat(),
                      source={"url": URL, "method": "POST", "body": [args["fba"]], "authentication": "anonymous"})
        result["request_attempted"] = True
        status, content_type, body = _read_public(args["fba"])
        result.update(http_status=status, content_type=diagnostic(content_type))
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError) as exc:
            result["body_preview"] = diagnostic(body.decode("utf-8", errors="replace"), truncated=len(body) > 2000)
            raise ValueError(f"Invalid JSON response, HTTP {status}: {exc}; {result['body_preview']}") from exc
        result.update(parse_result(payload, args, status))
    except Exception as exc:
        result["success"] = False
        result["error"] = {"code": "query_failed", "message": diagnostic(f"{type(exc).__name__}: {exc}")}
    return safe_output(result)
