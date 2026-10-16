"""Query one Yuntuo FBA with the original page's native header generator.

The endpoint, parameters and response came from the user's 2026-10-16 capture.
The public vendor bundle confirms $httpService.getRequestHeader(params).
Credentials stay in the browser; no copied token, signing algorithm or retries.
"""
from __future__ import annotations

from datetime import datetime, timezone
import os
import re
from typing import Any
from urllib.parse import urlsplit

from services.browser.store.store_driver_session import store_driver_session
from services.agent_cli.logistics.common import diagnostic, safe_output, safe_url
from services.agent_cli.logistics.yuntuo_parser import parse_result

HOST = "vip.yjtms.com"
ORIGIN = f"https://{HOST}:11000"
PAGE_PATH = "/customer/trackquery/"
PATH = "/tms-saas-oms/oms/tms/tracequery/list"

QUERY_SCRIPT = r"""
const fba = arguments[0];
const done = arguments[arguments.length - 1];
const meta = {http_status: null, request_attempted: false, header_source: 'page_http_service',
  response_truncated: false, fields_truncated: false, rows_truncated: false, traces_truncated: false};
let timer = null;
const secrets = [];
const clean = value => {
  let out = value;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
};
(async () => {
  if (location.origin !== 'https://vip.yjtms.com:11000' || location.pathname !== '/customer/trackquery/') {
    return {...meta, error: {code: 'page_mismatch', message: 'Expected https://vip.yjtms.com:11000/customer/trackquery/; observed ' + location.origin + location.pathname}};
  }
  // Vue attaches a component to its element. Read only the named service
  // capability, not component state, storage, cookies or webpack registries.
  // The original service manages authentication internally; generated values
  // remain local to this script and the fixed same-origin request.
  const services = new Set();
  const walker = document.createTreeWalker(document.documentElement, 1);
  let node = walker.currentNode;
  let scanned = 0;
  while (node && scanned < 2000) {
    const descriptor = Object.getOwnPropertyDescriptor(node, '__vue__');
    const vm = descriptor && descriptor.value;
    const service = vm && vm.$httpService;
    if (service && typeof service.getRequestHeader === 'function') services.add(service);
    scanned++;
    node = walker.nextNode();
  }
  meta.service_scan_truncated = Boolean(node);
  if (node || services.size !== 1) {
    return {...meta, error: {code: 'page_service_unavailable', message: 'Expected exactly one page $httpService within 2000 elements; observed ' + services.size + (node ? ' [truncated]' : '')}};
  }
  const service = services.values().next().value;
  const headers = service.getRequestHeader({noList: fba, queryType: 99});
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return {...meta, error: {code: 'invalid_page_headers', message: 'Page getRequestHeader did not return a header object'}};
  }
  for (const name of ['token', 'sign']) {
    if (typeof headers[name] === 'string' && headers[name]) secrets.push(headers[name]);
  }
  const allowed = new Set(['version', 'sign', 'token', 'timeZone', 'hyeCurrentStatId', 'locale']);
  for (const name of Object.keys(headers)) {
    if (!allowed.has(name) || !['string', 'number'].includes(typeof headers[name]) || String(headers[name]).length > 16384) {
      return {...meta, error: {code: 'invalid_page_headers', message: 'Unexpected native header name/type/length: ' + clean(name)}};
    }
  }
  if (['token', 'sign', 'version'].some(name => typeof headers[name] !== 'string' || !headers[name])) {
    return {...meta, error: {code: 'invalid_page_headers', message: 'Native token/sign/version headers must be nonempty strings'}};
  }
  const controller = new AbortController();
  timer = setTimeout(() => controller.abort(), 30000);
  meta.request_attempted = true;
  const response = await fetch('/tms-saas-oms/oms/tms/tracequery/list?noList=' + encodeURIComponent(fba) + '&queryType=99', {
    method: 'GET', headers, credentials: 'same-origin', redirect: 'error', signal: controller.signal
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
    return {...meta, body_preview: clean(body).slice(0, 4000), preview_truncated: body.length > 4000,
      error: {code: 'invalid_json', message: clean(String(error))}};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {...meta, error: {code: 'invalid_response', message: 'Expected JSON object; observed ' + clean(JSON.stringify(parsed)).slice(0, 1000)}};
  }
  const bounded = value => {
    if (typeof value === 'string') {
      if (value.length > 8000) {
        meta.fields_truncated = true;
        return clean(value).slice(0, 8000) + ' [truncated]';
      }
      return clean(value);
    }
    return value === null || ['number', 'boolean', 'undefined'].includes(typeof value)
      ? value : {invalid_type: Array.isArray(value) ? 'array' : 'object'};
  };
  const rows = parsed.body;
  meta.rows_truncated = Array.isArray(rows) && rows.length > 100;
  const projected = {result_code: bounded(parsed.result_code), message: bounded(parsed.message),
    solution: bounded(parsed.solution), traceId: bounded(parsed.traceId), body: bounded(rows)};
  if (Array.isArray(rows)) projected.body = rows.slice(0, 100).map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return bounded(row);
    const out = {};
    for (const key of ['carrier', 'destName', 'jobno', 'referenceno', 'refno', 'transportno']) {
      if (Object.prototype.hasOwnProperty.call(row, key)) out[key] = bounded(row[key]);
    }
    const traces = row.podInfoDTOList;
    if (Array.isArray(traces)) {
      if (traces.length > 200) meta.traces_truncated = true;
      out.podInfoDTOList = traces.slice(0, 200).map(trace => {
        if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return bounded(trace);
        const out = {};
        for (const key of ['ctrStation', 'isshow', 'remark', 'scanCode', 'scanDatetime', 'scanStation', 'scanStatus', 'scanTime']) {
          if (Object.prototype.hasOwnProperty.call(trace, key)) out[key] = bounded(trace[key]);
        }
        return out;
      });
    } else out.podInfoDTOList = bounded(traces);
    return out;
  });
  return {...meta, payload: projected};
})().then(result => done(result), error => done({...meta,
  error: {code: 'request_failed', message: clean(String(error))}})).finally(() => {
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
    if len(clean["store_id"]) > 256:
        raise ValueError("store_id length is invalid")
    if len(clean["fba"]) > 64 or not re.fullmatch(r"FBA[A-Z0-9]{7,}", clean["fba"]):
        raise ValueError("fba must be one complete uppercase FBA identifier (including any box suffix)")
    warehouse = clean.get("expected_warehouse", "")
    if not isinstance(warehouse, str) or (warehouse and not re.fullmatch(r"[A-Z0-9]{2,12}", warehouse)):
        raise ValueError("expected_warehouse must be an uppercase warehouse code")
    return clean


def parse_projection(response: dict[str, Any], args: dict[str, str]) -> dict[str, Any]:
    result: dict[str, Any] = {"success": False, "auth_refresh_required": False,
        "request_succeeded": False, "found": False, "matches": [], "complete": False}
    for key in ("http_status", "request_attempted", "header_source", "content_type",
                "response_truncated", "fields_truncated", "rows_truncated",
                "traces_truncated", "service_scan_truncated"):
        if key in response:
            result[key] = response[key]
    error = response.get("error")
    if isinstance(error, dict):
        result["error"] = {"code": str(error.get("code", "query_failed")),
                           "message": diagnostic(error.get("message", ""))}
        if "body_preview" in response:
            result["body_preview"] = diagnostic(response["body_preview"], truncated=bool(response.get("preview_truncated")))
            result["error"]["message"] += ": " + result["body_preview"]
        return result
    if any(response.get(key) is True for key in (
        "response_truncated", "fields_truncated", "rows_truncated", "traces_truncated")):
        result["error"] = {"code": "truncated_response", "message": "Response projection exceeded adapter budget [truncated]"}
        return result
    parsed = parse_result(response.get("payload"), http_status=response.get("http_status"),
        fba=args["fba"], expected_warehouse=args.get("expected_warehouse", ""))
    # Parser-only warning is replaced by the precise command validation limit.
    if parsed.get("success"):
        parsed["warnings"] = [warning for warning in parsed.get("warnings", [])
            if not warning.startswith("response_projection_only")]
        parsed["warnings"].append("single_response_only; other accounts/parcels/in-transit ETA are not verified")
    result.update(parsed)
    return result


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"success": False, "provider": "yuntuo",
        "auth_refresh_required": False, "request_succeeded": False, "found": False, "matches": []}
    try:
        args = _validate(arguments)
        if not os.environ.get("LXE_AGENT_SESSION_ID", "").strip():
            raise ValueError("LXE_AGENT_SESSION_ID is required; run in the LXE_Agent execution session")
        result.update(store_id=args["store_id"], fba=args["fba"],
            expected_warehouse=args.get("expected_warehouse", ""),
            source={"url": ORIGIN + PATH, "method": "GET",
                    "query": {"noList": args["fba"], "queryType": 99}},
            queried_at=datetime.now(timezone.utc).isoformat())
        with store_driver_session(args["store_id"], strict_attach=True, target_host=HOST) as (store, driver):
            driver.switch_to.default_content()
            page = urlsplit(driver.current_url)
            if page.scheme != "https" or page.netloc != f"{HOST}:11000" or page.path != PAGE_PATH:
                raise ValueError("Unexpected browser page: " + safe_url(driver.current_url))
            result.update(store_name=str(store.browser_name or ""), page_url=safe_url(driver.current_url))
            driver.set_script_timeout(40)
            response = driver.execute_async_script(QUERY_SCRIPT, args["fba"])
            if not isinstance(response, dict):
                raise ValueError("Selenium query returned a non-object: " + diagnostic(response))
            result.update(parse_projection(response, args))
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
