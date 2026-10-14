"""Read the captured Feiwo single-FBA endpoint in the paired store browser.

The GET contract and delivered-shipment fixture were supplied on 2026-10-14.
No account enumeration, arbitrary requests, retries, or business writes.
"""
from __future__ import annotations

from datetime import datetime, timezone
import os
import re
from typing import Any
from urllib.parse import urlsplit

from services.browser.store.store_driver_session import store_driver_session
from services.agent_cli.logistics.common import diagnostic, safe_output, safe_url

HOST = "feichi.nextsls.com"
ORIGIN = f"http://{HOST}"
PATH = "/tracking/app"
SHIPMENT_FIELDS = (
    "shipment_id", "client_reference", "ext_number", "outer_carrier_code",
    "outer_carrier_tracking_number", "status", "country", "postcode",
    "parcel_count", "self_reference",
)

# Fixed private adapter script. Credentials remain in the original browser.
QUERY_SCRIPT = r"""
const fba = arguments[0];
const done = arguments[arguments.length - 1];
const meta = {http_status: null, response_truncated: false, fields_truncated: false, traces_truncated: false};
let timer = null;
(async () => {
  if (location.origin !== 'http://feichi.nextsls.com' || location.pathname !== '/tracking/app') {
    return {...meta, error: {code: 'page_mismatch', message: 'Expected http://feichi.nextsls.com/tracking/app; observed ' + location.origin + location.pathname}};
  }
  const controller = new AbortController();
  timer = setTimeout(() => controller.abort(), 30000);
  const response = await fetch('/tracking/app?inajax=1&tracking_number=' + encodeURIComponent(fba), {
    method: 'GET', credentials: 'same-origin', redirect: 'error', signal: controller.signal
  });
  meta.http_status = response.status;
  meta.content_type = response.headers.get('content-type') || '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 2097152) {
      await reader.cancel();
      return {...meta, response_truncated: true, error: {code: 'response_too_large', message: 'Response exceeded 2097152 bytes [truncated]'}};
    }
    body += decoder.decode(chunk.value, {stream: true});
  }
  body += decoder.decode();
  let parsed;
  try { parsed = JSON.parse(body); }
  catch (error) {
    return {...meta, body_preview: body.slice(0, 4000), preview_truncated: body.length > 4000,
      error: {code: 'invalid_json', message: String(error)}};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {...meta, error: {code: 'invalid_response', message: 'Expected JSON object; observed ' + JSON.stringify(parsed).slice(0, 1000)}};
  }
  const bounded = value => {
    if (typeof value === 'string' && value.length > 8000) {
      meta.fields_truncated = true;
      return value.slice(0, 8000) + ' [truncated]';
    }
    return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)
      ? value : {invalid_type: Array.isArray(value) ? 'array' : 'object'};
  };
  const shipment = parsed.data && parsed.data.shipment;
  const shipmentPresent = Boolean(shipment && typeof shipment === 'object' && !Array.isArray(shipment));
  const out = {};
  if (shipmentPresent) {
    for (const key of ['shipment_id', 'client_reference', 'ext_number', 'outer_carrier_code',
      'outer_carrier_tracking_number', 'status', 'country', 'postcode', 'parcel_count', 'self_reference']) {
      if (Object.prototype.hasOwnProperty.call(shipment, key)) out[key] = bounded(shipment[key]);
    }
  }
  const traces = shipmentPresent && shipment.traces;
  meta.traces_truncated = Array.isArray(traces) && traces.length > 200;
  const projectedTraces = Array.isArray(traces) ? traces.slice(0, 200).map(trace => {
    if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return {invalid_type: true};
    return {time: bounded(trace.time), info: bounded(trace.info)};
  }) : bounded(traces);
  const businessStatus = bounded(parsed.status), info = bounded(parsed.info), requestTime = bounded(parsed.request_time);
  return {...meta, business_status: businessStatus, info,
    provider_request_time: requestTime, shipment_present: shipmentPresent,
    shipment: shipmentPresent ? out : bounded(shipment), traces: projectedTraces,
    trace_count: Array.isArray(traces) ? traces.length : null};
})().then(result => done(result), error => done({...meta,
  error: {code: 'request_failed', message: String(error)}})).finally(() => {
  if (timer !== null) clearTimeout(timer);
});
"""


def _validate(arguments: dict[str, Any]) -> dict[str, str]:
    unknown = set(arguments) - {"store_id", "fba", "expected_warehouse"}
    if unknown:
        raise ValueError("Unknown arguments: " + ", ".join(sorted(unknown)))
    for key in ("store_id", "fba"):
        if not isinstance(arguments.get(key), str) or not arguments[key].strip():
            raise ValueError(f"{key} is required")
    clean = {key: value.strip() if isinstance(value, str) else value for key, value in arguments.items()}
    if not 1 <= len(clean["store_id"]) <= 256:
        raise ValueError("store_id length is invalid")
    if not re.fullmatch(r"FBA[A-Z0-9]{7,}", clean["fba"]) or len(clean["fba"]) > 64:
        raise ValueError("fba must be one complete uppercase FBA identifier (including any box suffix)")
    warehouse = clean.get("expected_warehouse", "")
    if not isinstance(warehouse, str) or (warehouse and not re.fullmatch(r"[A-Z0-9]{2,12}", warehouse)):
        raise ValueError("expected_warehouse must be an uppercase warehouse code")
    return clean


def parse_result(response: dict[str, Any], arguments: dict[str, str]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "success": False, "auth_refresh_required": False, "request_succeeded": False,
        "found": False, "matched_count": 0, "matches": [], "complete": False,
        "http_status": response.get("http_status"),
        "content_type": diagnostic(response.get("content_type", "")),
        "business_status": response.get("business_status"),
        "info": diagnostic(response.get("info", "")),
        "provider_request_time": response.get("provider_request_time"),
        "response_truncated": response.get("response_truncated") is True,
        "fields_truncated": response.get("fields_truncated") is True,
        "traces_truncated": response.get("traces_truncated") is True,
    }

    def fail(code: str, message: str) -> dict[str, Any]:
        result["error"] = {"code": code, "message": diagnostic(message)}
        return result

    error = response.get("error")
    if isinstance(error, dict):
        message = diagnostic(error.get("message", ""))
        if "body_preview" in response:
            result["body_preview"] = diagnostic(response["body_preview"], truncated=bool(response.get("preview_truncated")))
            message += ": " + result["body_preview"]
        return fail(str(error.get("code", "request_failed")), message)
    status = response.get("http_status")
    if type(status) is not int or not 200 <= status < 300:
        return fail("http_error", f"HTTP {status}: {result['info']}; status={result['business_status']}")
    if any(result[key] for key in ("response_truncated", "fields_truncated", "traces_truncated")):
        return fail("truncated_response", "Response/fields/traces exceed the adapter budget [truncated]")
    if type(response.get("business_status")) is not int or response["business_status"] != 1:
        # No not-found contract has been captured; retain the real provider status/info.
        return fail("provider_error", diagnostic({"status": response.get("business_status"), "info": response.get("info")}))
    shipment = response.get("shipment")
    if response.get("shipment_present") is not True or not isinstance(shipment, dict):
        return fail("invalid_shipment", "Expected data.shipment object; observed " + diagnostic(shipment))
    for key in SHIPMENT_FIELDS:
        value = shipment.get(key)
        if key != "parcel_count" and value is not None and not isinstance(value, str):
            return fail("invalid_shipment", f"Invalid shipment field {key}: " + diagnostic(value))
    count = shipment.get("parcel_count")
    if count is not None and (type(count) is not int or count < 0):
        return fail("invalid_shipment", "Invalid parcel_count: " + diagnostic(count))
    traces = response.get("traces")
    if not isinstance(traces, list) or any(
        not isinstance(trace, dict) or not isinstance(trace.get("time"), str)
        or not isinstance(trace.get("info"), str) for trace in traces
    ):
        return fail("invalid_traces", "Expected shipment.traces array of time/info strings; observed " + diagnostic(traces))
    fba = shipment.get("ext_number")
    if not isinstance(fba, str) or not re.fullmatch(r"FBA[A-Z0-9]{7,}", fba):
        return fail("invalid_shipment", "Missing/invalid full FBA in ext_number: " + diagnostic(fba))
    result["request_succeeded"] = True
    if fba != arguments["fba"]:
        return fail("identity_mismatch", f"Requested {arguments['fba']}; response ext_number={fba}")
    carrier = shipment.get("outer_carrier_code") or ""
    raw_tracking = shipment.get("outer_carrier_tracking_number") or ""
    # Only the explicit carrier prefix + one number layout is captured. Never
    # turn arbitrary numeric fragments or another carrier's prefix into a match.
    tracking = raw_tracking.strip()
    if carrier and tracking.upper().startswith(carrier.upper() + " "):
        tracking = tracking[len(carrier):].strip()
    numbers = [tracking] if carrier and re.fullmatch(r"(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{6,}", tracking) else []
    missing = [key for key, value in (
        ("shipment_number", shipment.get("shipment_id")), ("carrier", carrier),
        ("tracking_numbers", numbers), ("warehouse", None),
    ) if not value]
    warnings = ["warehouse_unavailable; postcode/city are not warehouse codes",
                "eta_unavailable; port/clearance dates are not final-delivery estimates",
                "trace_timezone_unspecified; preserve provider time text",
                "provider_traces; not an independent carrier verification"]
    if raw_tracking and not numbers:
        warnings.append("carrier_tracking_layout_unrecognized")
    if count is not None and count > 1:
        warnings.append("multiple_parcels; one tracking field does not prove complete parcel coverage")
    if arguments.get("expected_warehouse"):
        warnings.append("expected_warehouse_not_verified")
    match = {
        "fba_numbers": [fba], "shipment_number": shipment.get("shipment_id") or "",
        "carrier": carrier, "tracking_numbers": numbers,
        "shipment_status": shipment.get("status") or "", "parcel_count": count,
        "country": shipment.get("country") or "", "postcode": shipment.get("postcode") or "",
        "warehouse": None, "warehouse_matches": None, "eta": None,
        "traces": traces, "trace_timezone": None,
        "source_fields": {key: shipment[key] for key in SHIPMENT_FIELDS if key in shipment},
        "missing_fields": missing, "warnings": warnings,
    }
    result.update(success=True, found=True, matched_count=1, matches=[match],
                  status="matched", complete=True, trace_count=len(traces), warnings=warnings)
    return result


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"success": False, "auth_refresh_required": False,
        "request_succeeded": False, "found": False, "matches": [], "provider": "feiwo"}
    try:
        args = _validate(arguments)
        if not os.environ.get("LXE_AGENT_SESSION_ID", "").strip():
            raise ValueError("LXE_AGENT_SESSION_ID is required; run in the LXE_Agent execution session")
        result.update(store_id=args["store_id"], fba=args["fba"],
            expected_warehouse=args.get("expected_warehouse", ""),
            source={"url": ORIGIN + PATH, "method": "GET",
                    "query": {"inajax": "1", "tracking_number": args["fba"]}},
            queried_at=datetime.now(timezone.utc).isoformat())
        with store_driver_session(args["store_id"], strict_attach=True, target_host=HOST) as (store, driver):
            driver.switch_to.default_content()
            page = urlsplit(driver.current_url)
            if page.scheme != "http" or page.netloc != HOST or page.path != PATH:
                raise ValueError("Unexpected browser page: " + safe_url(driver.current_url))
            result.update(store_name=str(store.browser_name or ""), page_url=safe_url(driver.current_url))
            driver.set_script_timeout(40)
            response = driver.execute_async_script(QUERY_SCRIPT, args["fba"])
            if not isinstance(response, dict):
                raise ValueError("Selenium query returned a non-object: " + diagnostic(response))
            result.update(parse_result(response, args))
    except Exception as exc:
        parts = [f"{type(exc).__name__}: {exc}"]
        cause = exc.__cause__
        for _ in range(3):
            if cause is None:
                break
            parts.append(f"caused by {type(cause).__name__}: {cause}")
            cause = cause.__cause__
        result["success"] = False
        result["error"] = {"code": "query_failed", "message": diagnostic("; ".join(parts))}
    return safe_output(result)
