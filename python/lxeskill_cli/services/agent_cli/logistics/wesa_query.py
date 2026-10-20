"""Query the verified Wesa shipment list through paired Selenium, without login export.

The two payloads and HTML field shapes come from the 2026-10-13 handoff and
the user's real response. One invocation reads one explicitly selected page;
it does not enumerate other accounts, follow response actions, or retry.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import re
from typing import Any
from urllib.parse import urlsplit

from services.browser.store.store_driver_session import store_driver_session
from services.agent_cli.logistics.common import diagnostic, html_text
from services.agent_cli.logistics.common import safe_output as _safe_output
from services.agent_cli.logistics.common import safe_url as _safe_url

HOST = "wsaexp.nextsls.com"
ORIGIN = f"http://{HOST}"
PATH = "/rest/tms/wos/shipment/lists"
FBA_PATTERN = re.compile(r"FBA[A-Z0-9]{7,}")
ROW_FIELDS = ("shipment_id", "shipment_number", "to_warehouse_code", "outer_carrier", "parcel_count", "service")

# This is private adapter code, never caller-supplied JavaScript or a URL.
# Browser credentials stay in the browser. Return only the business projection,
# not headers, cookies, component actions, input values or authentication state.
QUERY_SCRIPT = r"""
const payload = JSON.parse(arguments[0]);
const accountName = arguments[1];
const done = arguments[arguments.length - 1];
const meta = {http_status: null, account_visible: false, response_truncated: false, fields_truncated: false};
let controller = null;
let timer = null;
(async () => {
  if (location.origin !== 'http://wsaexp.nextsls.com') {
    return {...meta, error: {code: 'origin_mismatch', message: 'Expected http://wsaexp.nextsls.com; observed ' + location.origin}};
  }
  meta.account_visible = Boolean(document.body && document.body.innerText.includes(accountName));
  if (!meta.account_visible) {
    return {...meta, error: {code: 'account_not_visible', message: 'Expected company account is not present in visible page text: ' + accountName}};
  }
  controller = new AbortController();
  timer = setTimeout(() => controller.abort(), 30000);
  const response = await fetch('/rest/tms/wos/shipment/lists', {
    method: 'POST', credentials: 'same-origin', redirect: 'error',
    headers: {'Content-Type': 'application/json;charset=utf-8'},
    body: JSON.stringify(payload), signal: controller.signal
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
  const grid = parsed.data && parsed.data.components && parsed.data.components.gridView;
  const table = grid && grid.table;
  const rows = table && table.dataSource;
  const pagination = table && table.pagination;
  const tabs = grid && grid.tabs;
  return {...meta, business_success: parsed.success, info: parsed.info,
    error_code: parsed.errorCode, errors: parsed.errors,
    list_present: Array.isArray(rows), row_count: Array.isArray(rows) ? rows.length : null,
    rows_truncated: Array.isArray(rows) && rows.length > 100,
    invalid_row: Array.isArray(rows) && rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)),
    rows: Array.isArray(rows) ? rows.slice(0, 100).map(row => {
      const out = {};
      if (row && typeof row === 'object') {
        for (const key of ['shipment_id', 'shipment_number', 'to_warehouse_code', 'outer_carrier', 'parcel_count', 'service']) {
          if (Object.prototype.hasOwnProperty.call(row, key)) {
            const value = row[key];
            if (typeof value === 'string' && value.length > 8000) {
              meta.fields_truncated = true;
              out[key] = value.slice(0, 8000) + ' [truncated]';
            } else out[key] = value;
          }
        }
      }
      return out;
    }) : [],
    // Compute after projecting rows, since projection can flag long fields.
    fields_truncated: meta.fields_truncated,
    pagination: pagination && {page: pagination.page, pageSize: pagination.pageSize, total: pagination.total},
    tabs: tabs && {activeTab: tabs.activeTab, items: Array.isArray(tabs.items) ? tabs.items.slice(0, 20).map(item => ({value: item.value, label: item.label})) : []}
  };
})().then(result => done(result), error => done({...meta,
  error: {code: 'request_failed', message: String(error)}})).finally(() => {
  if (timer !== null) clearTimeout(timer);
});
"""


def _validate(arguments: dict[str, Any]) -> dict[str, Any]:
    allowed = {"store_id", "fba", "account_name", "expected_warehouse", "query_mode", "page"}
    unknown = set(arguments) - allowed
    if unknown:
        raise ValueError("Unknown arguments: " + ", ".join(sorted(unknown)))
    for key in ("store_id", "fba", "account_name"):
        if not isinstance(arguments.get(key), str) or not arguments[key].strip():
            raise ValueError(f"{key} is required")
    clean = {key: value.strip() if isinstance(value, str) else value for key, value in arguments.items()}
    if not FBA_PATTERN.fullmatch(clean["fba"]) or len(clean["fba"]) > 64:
        raise ValueError("fba must be one complete uppercase FBA identifier (including any box suffix)")
    if len(clean["store_id"]) > 256 or not 2 <= len(clean["account_name"]) <= 200:
        raise ValueError("store_id/account_name length is invalid")
    if clean.get("query_mode", "all") not in {"all", "delivered"}:
        raise ValueError("query_mode must be all or delivered")
    page = clean.get("page", 1)
    if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= 1000:
        raise ValueError("page must be an integer between 1 and 1000")
    warehouse = clean.get("expected_warehouse", "")
    if not isinstance(warehouse, str) or (warehouse and not re.fullmatch(r"[A-Z0-9]{2,12}", warehouse)):
        raise ValueError("expected_warehouse must be an uppercase warehouse code")
    return {**clean, "page": page, "query_mode": clean.get("query_mode", "all")}


def request_payload(fba: str, mode: str = "all", page: int = 1) -> dict[str, Any]:
    if mode == "all":
        # Reproduce the separately captured “全部” request. In particular, do
        # not change isActiveTab to all, merge the payloads or add pageSize here.
        return {"timeLimit": 0, "page": page, "activeTab": "all", "keywords": fba,
                "isActiveTab": "delivered", "init": 1, "scenes": 0}
    if mode != "delivered":
        raise ValueError("query_mode must be all or delivered")
    return {"timeLimit": 0, "page": page, "pageSize": 30, "keywords": fba,
            "isActiveTab": "delivered", "service": "", "btnType": "", "config": "",
            "country": "", "created_daterange": "", "def_fields": "", "delivered_daterange": "",
            "depot_id": "", "name": "", "picking_daterange": "", "pickup_depot_id": "",
            "postcode": "", "restart": 0, "scenes": 0, "store_id": "", "to_warehouse_code": ""}


def parse_row(row: dict[str, Any], fba: str, expected_warehouse: str = "") -> dict[str, Any] | None:
    raw = {key: row.get(key, "") for key in ROW_FIELDS}
    if any(not isinstance(value, str) for key, value in raw.items() if key != "parcel_count"):
        raise ValueError("Shipment field must be a string: " + diagnostic(raw))
    count = raw["parcel_count"]
    if isinstance(count, bool) or not isinstance(count, (str, int)) or (isinstance(count, int) and count < 0):
        raise ValueError("Shipment field parcel_count must be a string or non-negative integer: " + diagnostic(count))
    text = {key: html_text(value) for key, value in raw.items() if key != "parcel_count"}
    text["parcel_count"] = html_text(count) if isinstance(count, str) else str(count)
    # Boundaries prevent matching FBA123... inside a longer shipment/box number.
    fbas = list(dict.fromkeys(re.findall(r"(?<![A-Za-z0-9])FBA[A-Z0-9]{7,}(?![A-Za-z0-9])", text["shipment_id"])))
    if fba not in fbas:
        return None
    lines = [line.strip() for line in text["outer_carrier"].splitlines() if line.strip()]
    carrier = lines[0] if lines else ""
    # Only accept the observed carrier-on-first-line/number-on-following-lines
    # layout. Unrecognized text stays in source_text and is flagged, not guessed.
    tracking: list[str] = []
    ambiguous = False
    for line in lines[1:]:
        if re.fullmatch(r"(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{6,}", line):
            if line not in tracking:
                tracking.append(line)
        else:
            ambiguous = True
    missing = [key for key, value in (("shipment_number", text["shipment_number"]),
               ("warehouse", text["to_warehouse_code"]), ("carrier", carrier), ("tracking_numbers", tracking)) if not value]
    warnings = (["carrier_layout_unrecognized"] if ambiguous else [])
    warehouse_matches = text["to_warehouse_code"] == expected_warehouse if expected_warehouse else None
    if warehouse_matches is False:
        warnings.append("warehouse_mismatch")
    return {"fba_numbers": fbas, "shipment_number": text["shipment_number"],
            "warehouse": text["to_warehouse_code"], "warehouse_matches": warehouse_matches,
            "carrier": carrier, "tracking_numbers": tracking, "parcel_count": text["parcel_count"] if isinstance(count, str) else count,
            "service": text["service"], "source_text": text, "source_html": raw,
            "missing_fields": missing, "warnings": warnings}


def parse_result(response: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    """Interpret the adapter's bounded projection, never trust HTTP 200 alone."""
    result: dict[str, Any] = {"success": False, "auth_refresh_required": False,
        "request_succeeded": False, "found": False, "matched_count": 0, "matches": [],
        "http_status": response.get("http_status"), "content_type": diagnostic(response.get("content_type", "")),
        "account_visible": response.get("account_visible") is True,
        "response_truncated": response.get("response_truncated") is True,
        "business_success": response.get("business_success"),
        "info": diagnostic(response.get("info", "")), "error_code": diagnostic(response.get("error_code", "")),
        "errors": _safe_output(response.get("errors", [])), "list_present": response.get("list_present") is True,
        "fields_truncated": response.get("fields_truncated") is True}
    error = response.get("error")
    if isinstance(error, dict):
        message = diagnostic(error.get("message", ""))
        if "body_preview" in response:
            result["body_preview"] = diagnostic(response["body_preview"], truncated=bool(response.get("preview_truncated")))
            message += ": " + result["body_preview"]
        result["error"] = {"code": str(error.get("code", "request_failed")), "message": diagnostic(message)}
        return result
    status = response.get("http_status")
    if not isinstance(status, int) or not 200 <= status < 300:
        result["error"] = {"code": "http_error", "message": f"HTTP {status}: {result['info']}; errorCode={result['error_code']}; errors={result['errors']}"}
        return result
    if type(response.get("business_success")) is not int or response["business_success"] != 1 or response.get("error_code") not in (None, "") or response.get("errors") not in (None, [], {}):
        result["error"] = {"code": "provider_error", "message": diagnostic({key: response.get(key) for key in ("business_success", "info", "error_code", "errors")})}
        return result
    rows = response.get("rows")
    if result["response_truncated"] or result["fields_truncated"]:
        result["error"] = {"code": "truncated_response", "message": "Response/fields exceed the adapter budget [truncated]"}
        return result
    if not result["list_present"] or not isinstance(rows, list) or response.get("invalid_row"):
        result["error"] = {"code": "invalid_list", "message": "Expected data.components.gridView.table.dataSource to be an array of objects"}
        return result
    pagination = response.get("pagination")
    required = ("page", "pageSize", "total")
    if not isinstance(pagination, dict) or any(isinstance(pagination.get(key), bool) or not isinstance(pagination.get(key), int) for key in required):
        result["error"] = {"code": "invalid_pagination", "message": "Invalid pagination: " + diagnostic(pagination)}
        return result
    page, size, total = (pagination[key] for key in required)
    result["pagination"] = pagination
    if page != arguments["page"] or size <= 0 or total < 0 or total < len(rows) or len(rows) > size or (rows and (page - 1) * size >= total):
        result["error"] = {"code": "invalid_pagination", "message": "Inconsistent pagination: " + diagnostic(pagination)}
        return result
    result["request_succeeded"] = True
    matches = [match for row in rows if (match := parse_row(row, arguments["fba"], arguments.get("expected_warehouse", ""))) is not None]
    result.update(found=bool(matches), matched_count=len(matches), matches=matches,
                  returned_row_count=response.get("row_count"), rows_truncated=bool(response.get("rows_truncated")))
    result["complete"] = page == 1 and total == len(rows) and not result["rows_truncated"] and not result["response_truncated"]
    tabs = response.get("tabs")
    result["returned_active_tab"] = tabs.get("activeTab") if isinstance(tabs, dict) else None
    result["all_tab_confirmed"] = arguments["query_mode"] == "all" and result["returned_active_tab"] == "all"
    result["warnings"] = []
    if not result["complete"]:
        result["warnings"].append("partial_page; other pages were not queried")
    if len(matches) > 1:
        result["warnings"].append("multiple_matching_rows")
    if arguments["query_mode"] == "all" and not result["all_tab_confirmed"]:
        result["warnings"].append("returned_active_tab_not_all; cross-status coverage unverified")
    result["status"] = "matched" if matches else ("not_found" if result["complete"] else "not_found_on_page")
    # Query success is distinct from finding a usable transfer number.
    result["success"] = True
    return result


def run(arguments):
    result: dict[str, Any] = {"success": False, "auth_refresh_required": False,
        "request_succeeded": False, "found": False, "matches": [], "provider": "wesa"}
    try:
        args = _validate(arguments)
        if not os.environ.get("LXE_AGENT_SESSION_ID", "").strip():
            raise ValueError("LXE_AGENT_SESSION_ID is required; run in the LXE_Agent execution session")
        payload = request_payload(args["fba"], args["query_mode"], args["page"])
        result.update(store_id=args["store_id"], fba=args["fba"], account_name=args["account_name"],
            account_evidence_source="expected company name in visible page text; confirm using the current snapshot",
            expected_warehouse=args.get("expected_warehouse", ""), query_mode=args["query_mode"],
            source={"url": ORIGIN + PATH, "method": "POST", "payload": payload},
            queried_at=datetime.now(timezone.utc).isoformat())
        with store_driver_session(args["store_id"], strict_attach=True, target_host=HOST) as (store, driver):
            driver.switch_to.default_content()
            if urlsplit(driver.current_url).netloc != HOST or not driver.current_url.startswith(ORIGIN + "/"):
                raise ValueError("Unexpected browser origin: " + _safe_url(driver.current_url))
            result["store_name"] = str(store.browser_name or "")
            result["page_url"] = _safe_url(driver.current_url)
            driver.set_script_timeout(40)
            response = driver.execute_async_script(QUERY_SCRIPT, json.dumps(payload, ensure_ascii=False), args["account_name"])
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
    # Redact all returned fields, including provider text/HTML and driver errors.
    return _safe_output(result)
