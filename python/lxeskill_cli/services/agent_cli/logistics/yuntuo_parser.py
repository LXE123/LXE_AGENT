"""Parse the user-captured Yuntuo trace response; no requests or login access.

The 2026-10-16 response establishes its shape and the supplied getTrack source
labels refno as the transfer number. Authentication generation remains unknown.
"""
from __future__ import annotations

import re
from typing import Any

from services.agent_cli.logistics.common import diagnostic, safe_output

ROW_FIELDS = ("carrier", "destName", "jobno", "referenceno", "refno", "transportno")
TRACE_FIELDS = ("ctrStation", "isshow", "remark", "scanCode", "scanDatetime",
                "scanStation", "scanStatus", "scanTime")
MAX_ROWS = 100
MAX_TRACES = 200
MAX_FIELD_CHARS = 8000


def parse_result(payload: Any, *, http_status: int, fba: str,
                 expected_warehouse: str = "") -> dict[str, Any]:
    """Project known fields, exact-match the full FBA, and preserve trace order.

    This parser has no authority to classify an unobserved empty/error response
    as not-found/login-expired, or to infer the carrier from a transfer number.
    It does not read timestamps as destination-local delivery dates.
    """
    result: dict[str, Any] = {
        "success": False, "provider": "yuntuo", "auth_refresh_required": False,
        "request_succeeded": False, "found": False, "matched_count": 0,
        "matches": [], "complete": False, "http_status": http_status,
    }

    def fail(code: str, message: str) -> dict[str, Any]:
        result["error"] = {"code": code, "message": diagnostic(message)}
        return safe_output(result)

    if not isinstance(fba, str) or len(fba) > 64 or not re.fullmatch(r"FBA[A-Z0-9]{7,}", fba):
        return fail("invalid_arguments", "Expected one complete uppercase FBA identifier")
    if not isinstance(expected_warehouse, str) or (expected_warehouse and not re.fullmatch(r"[A-Z0-9]{2,12}", expected_warehouse)):
        return fail("invalid_arguments", "expected_warehouse must be an uppercase warehouse code")
    if not isinstance(payload, dict):
        return fail("invalid_response", "Expected JSON object; observed " + diagnostic(payload))
    # These are provider diagnostics, not inferred errors or login advice.
    for key in ("result_code", "message", "solution", "traceId"):
        value = payload.get(key)
        if key == "result_code" and type(value) is int:
            result[key] = value
        elif value is None or isinstance(value, str):
            result[key] = diagnostic(value) if value is not None else None
        else:
            return fail("invalid_response", f"Invalid {key}: " + diagnostic(value))
    if type(http_status) is not int or not 200 <= http_status < 300:
        return fail("http_error", diagnostic({"http_status": http_status,
            "result_code": result.get("result_code"), "message": result.get("message"),
            "solution": result.get("solution")}))
    if type(payload.get("result_code")) is not int:
        return fail("invalid_response", "Expected integer result_code; observed " + diagnostic(payload.get("result_code")))
    if payload["result_code"] != 0:
        return fail("provider_error", diagnostic({key: payload.get(key)
            for key in ("result_code", "message", "solution", "traceId")}))
    rows = payload.get("body")
    if not isinstance(rows, list):
        return fail("invalid_response", "Expected body array; observed " + diagnostic(rows))
    result["returned_count"] = len(rows)
    if len(rows) > MAX_ROWS:
        result["rows_truncated"] = True
        return fail("truncated_response", f"body exceeded {MAX_ROWS} rows [truncated]")
    if not rows:
        # No real empty result has been captured. Do not assert business absence.
        return fail("empty_result_unverified", "Observed result_code=0 and body=[]; empty-result contract is unverified")

    matches = []
    for row_index, row in enumerate(rows):
        if not isinstance(row, dict):
            return fail("invalid_shipment", f"Invalid body[{row_index}]: " + diagnostic(row))
        fields = {key: row[key] for key in ROW_FIELDS if key in row}
        for key, value in fields.items():
            if not isinstance(value, str):
                return fail("invalid_shipment", f"Invalid body[{row_index}].{key}: " + diagnostic(value))
            if len(value) > MAX_FIELD_CHARS:
                result["fields_truncated"] = True
                return fail("truncated_response", f"body[{row_index}].{key} exceeded {MAX_FIELD_CHARS} characters [truncated]")
        reference = fields.get("referenceno")
        if not isinstance(reference, str) or not re.fullmatch(r"FBA[A-Z0-9]{7,}", reference):
            return fail("invalid_shipment", "Expected one complete FBA in referenceno; observed " + diagnostic(reference))
        if reference != fba:
            return fail("identity_mismatch", f"Requested {fba}; body[{row_index}].referenceno={reference}")
        raw_traces = row.get("podInfoDTOList")
        if not isinstance(raw_traces, list):
            return fail("invalid_traces", f"Expected body[{row_index}].podInfoDTOList array; observed " + diagnostic(raw_traces))
        if len(raw_traces) > MAX_TRACES:
            result["traces_truncated"] = True
            return fail("truncated_response", f"body[{row_index}].podInfoDTOList exceeded {MAX_TRACES} traces [truncated]")
        traces = []
        for trace_index, raw_trace in enumerate(raw_traces):
            if not isinstance(raw_trace, dict):
                return fail("invalid_traces", f"Invalid trace[{trace_index}]: " + diagnostic(raw_trace))
            trace = {key: raw_trace[key] for key in TRACE_FIELDS if key in raw_trace}
            for key, value in trace.items():
                if key in {"isshow", "scanDatetime"}:
                    if type(value) is not int:
                        return fail("invalid_traces", f"Invalid trace[{trace_index}].{key}: " + diagnostic(value))
                elif not isinstance(value, str):
                    return fail("invalid_traces", f"Invalid trace[{trace_index}].{key}: " + diagnostic(value))
                elif len(value) > MAX_FIELD_CHARS:
                    result["fields_truncated"] = True
                    return fail("truncated_response", f"trace[{trace_index}].{key} exceeded {MAX_FIELD_CHARS} characters [truncated]")
            if any(not isinstance(trace.get(key), str) for key in ("scanTime", "scanStatus", "remark")):
                return fail("invalid_traces", f"Expected scanTime/scanStatus/remark strings in trace[{trace_index}]; observed " + diagnostic(trace))
            traces.append(trace)
        carrier = fields.get("carrier") or None
        raw_tracking = fields.get("refno") or ""
        # getTrack explicitly labels refno as the transfer number. Only the
        # captured single alphanumeric value is recognized; no splitting of
        # unobserved multiple-number layouts, prefixes or URLs.
        tracking = raw_tracking.strip()
        numbers = [tracking] if re.fullmatch(r"(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{6,}", tracking) else []
        missing = [key for key, value in (("shipment_number", fields.get("jobno")),
            ("carrier", carrier), ("warehouse", None), ("tracking_numbers", numbers)) if not value]
        warnings = [
            "warehouse_unavailable; destName/cities are not warehouse codes",
            "eta_unavailable; port ETA is not a final-delivery estimate",
            "trace_timezone_unspecified; preserve scanTime and raw scanDatetime separately",
            "provider_traces; not an independent carrier verification",
            "parcel_coverage_unverified; no parcel count in captured response",
        ]
        if carrier is None:
            warnings.append("carrier_unavailable; do not infer from refno format or trace mentions")
        if raw_tracking and not numbers:
            warnings.append("tracking_layout_unrecognized; preserve raw refno")
        if expected_warehouse:
            warnings.append("expected_warehouse_not_verified")
        matches.append({
            "fba_numbers": [reference], "shipment_number": fields.get("jobno") or "",
            "carrier": carrier, "reference_number": fields.get("refno") or "",
            "transport_number": fields.get("transportno") or "",
            "destination": fields.get("destName") or "",
            "tracking_numbers": numbers, "tracking_number_source": "refno",
            "warehouse": None, "warehouse_matches": None,
            "eta": None, "parcel_count": None, "trace_timezone": None,
            "traces": traces, "trace_count": len(traces), "source_fields": fields,
            "missing_fields": missing, "warnings": warnings,
        })
    warnings = ["response_projection_only; no authentication or live-query verification"]
    if len(matches) > 1:
        warnings.append("multiple_matching_rows; preserve all, do not select the first")
    result.update(success=True, request_succeeded=True, found=True,
        matched_count=len(matches), matches=matches, complete=True,
        warnings=warnings)
    return safe_output(result)
