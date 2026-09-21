"""Read-only native cloud diagnostics, independent of desktop credentials."""
from __future__ import annotations


from shared.infra.cloud_client import (
    CloudClient,
    CloudConnectionError,
    diagnostic,
    redact,
)

from lxeskill.cloud_context import CONTEXT_PATH, query_device_context, server_url, validate_device_context

MABANG_PATH = "/api/v1/data-sources/mabang/apis"


def _server_url(arguments):
    return server_url(arguments, "cloud-status")


def run_cloud_status(arguments):
    """Return the regular CLI result and exit code; never read desktop state."""
    result = {"type": "result", "command": "cloud-status", "ok": False, "data": {}, "files": []}
    if arguments in (["--help"], ["-h"]):
        result.update(ok=True, data={
            "usage": "lxeskill cloud-status [--server <http(s)://host:port>]",
            "description": "Query this device and verify Mabang access without business tokens or upstream calls.",
            "server_default": "LXE_DATA_SERVER_URL", "checks": [CONTEXT_PATH, MABANG_PATH],
        })
        return result, 0
    try:
        server = _server_url(arguments)
    except ValueError as exc:
        result["error"] = {"code": "invalid_arguments", "message": diagnostic(str(exc))}
        return result, 2
    result["data"] = {"server_url": server, "checks": [], "upstream_queried": False}
    client = CloudClient(server)
    for name, path in (("device_context", CONTEXT_PATH), ("mabang_access", MABANG_PATH)):
        check = {"name": name, "path": path, "ok": False}
        result["data"]["checks"].append(check)
        try:
            response = query_device_context(client) if name == "device_context" else client.request_json("GET", path)
        except CloudConnectionError as exc:
            if exc.http_status is not None:
                check["http_status"] = exc.http_status
            check["elapsed_ms"] = exc.elapsed_ms
            result["error"] = {"code": "cloud_connection_failed", "stage": name,
                               "message": str(exc)}
            return result, 3
        check["http_status"] = response.status_code
        check["elapsed_ms"] = response.elapsed_ms
        payload, truncated = response.payload, response.truncated
        if not 200 <= check["http_status"] < 300:
            detail = payload.get("detail") if isinstance(payload, dict) else None
            code = detail.get("code") if isinstance(detail, dict) else None
            result["error"] = {"code": diagnostic(code) if isinstance(code, str) else "cloud_http_error",
                               "stage": name, "http_status": check["http_status"],
                               "message": diagnostic(payload, truncated)}
            return result, 4
        valid = isinstance(payload, dict) and not truncated
        if name == "device_context":
            try:
                validate_device_context(payload)
            except (ValueError, TypeError):
                valid = False
        else:
            valid = valid and payload.get("data_source") == "mabang" and isinstance(payload.get("apis"), list)
        if not valid:
            result["error"] = {"code": "cloud_invalid_response", "stage": name,
                               "message": "Unexpected response: " + diagnostic(payload, truncated)}
            return result, 4
        check["ok"] = True
        if name == "device_context":
            result["data"]["device_context"] = redact(payload)
        else:
            result["data"]["mabang_api_count"] = len(payload["apis"])
    result["ok"] = True
    return result, 0
