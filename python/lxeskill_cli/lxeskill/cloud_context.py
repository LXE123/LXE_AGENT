"""Standalone device context discovery. No business runtime or permission gate."""
from __future__ import annotations

from ipaddress import ip_address
import os
import re

from shared.infra.cloud_client import CloudClient, CloudConnectionError, diagnostic, normalize_server_url, redact

CONTEXT_PATH = "/api/v1/device-context"
NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
PROFILE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")


def server_url(arguments, command):
    if not arguments:
        value = os.getenv("LXE_DATA_SERVER_URL", "").strip()
    elif len(arguments) == 2 and arguments[0] == "--server":
        value = arguments[1].strip()
    else:
        raise ValueError(f"Usage: lxeskill {command} [--server <http(s)://host:port>]")
    return normalize_server_url(value)


def validate_device_context(value):
    """Validate the wire contract, without mapping profile names to grants."""
    def require(condition, message):
        if not condition:
            raise ValueError(message)
    def integer(value, minimum=0):
        return type(value) is int and minimum <= value <= 9007199254740991
    require(isinstance(value, dict) and value.get("response_schema") == "lxe.device-context.v1", "Unsupported device context schema")
    device, permission = value.get("device"), value.get("permission")
    require(isinstance(device, dict) and isinstance(permission, dict), "Missing device or permission object")
    require(device.get("kind") in {"managed_device", "system_administrator"}, "Invalid device kind")
    for key in ("id", "display_name", "wireguard_ip"):
        require(isinstance(device.get(key), str) and bool(device[key].strip()), f"Invalid device {key}")
    ip_address(device["wireguard_ip"])
    require(integer(permission.get("assignment_version")), "Invalid permission assignment version")
    grants = permission.get("grants")
    require(isinstance(grants, dict), "Missing permission grants")
    for key in ("skill_types", "desktop_features", "server_capabilities", "erp_actions"):
        names = grants.get(key)
        require(isinstance(names, list) and len(names) <= 64, f"Invalid grants {key}")
        require(all(isinstance(n, str) and (n == "*" or NAME.fullmatch(n)) for n in names), f"Invalid grant name in {key}")
        require(len(names) == len(set(names)) and ("*" not in names or len(names) == 1), f"Invalid grant list {key}")
    require("profile" in permission, "Missing permission profile")
    profile = permission["profile"]
    if profile is None:
        require(not any(grants[k] for k in ("skill_types", "desktop_features", "server_capabilities", "erp_actions")), "Unassigned device has grants")
    else:
        require(isinstance(profile, dict) and isinstance(profile.get("id"), str) and PROFILE.fullmatch(profile["id"]), "Invalid profile id")
        require(integer(permission["assignment_version"], 1) and integer(profile.get("revision"), 1), "Invalid profile version")
        labels = profile.get("labels")
        require(isinstance(labels, dict), "Invalid profile labels")
        for locale in ("zh-CN", "en-US"):
            label = labels.get(locale)
            require(isinstance(label, str) and 0 < len(label.strip()) <= 64, "Invalid profile label")
    return value


def query_device_context(client):
    # HTTP/transport errors remain distinguishable for each command's output contract.
    return client.request_json("GET", CONTEXT_PATH)


def run_cloud_context(arguments):
    result = {"type": "result", "command": "cloud-context", "ok": False, "data": {}, "files": []}
    if arguments in (["--help"], ["-h"]):
        result.update(ok=True, data={"usage": "lxeskill cloud-context [--server <http(s)://host:port>]",
            "description": "Query this device's current skill grants without business credentials.", "server_default": "LXE_DATA_SERVER_URL"})
        return result, 0
    try:
        server = server_url(arguments, "cloud-context")
    except ValueError as exc:
        result["error"] = {"code": "invalid_arguments", "message": diagnostic(str(exc))}
        return result, 2
    try:
        response = query_device_context(CloudClient(server, timeout=10))
    except CloudConnectionError as exc:
        result["error"] = {"code": "cloud_connection_failed", "message": str(exc)}
        if exc.http_status is not None:
            result["error"]["http_status"] = exc.http_status
        return result, 3
    if not 200 <= response.status_code < 300:
        detail = response.payload.get("detail") if isinstance(response.payload, dict) else None
        code = detail.get("code") if isinstance(detail, dict) else None
        result["error"] = {"code": diagnostic(code) if isinstance(code, str) else "cloud_http_error",
            "http_status": response.status_code, "message": diagnostic(response.payload, response.truncated)}
        return result, 4
    try:
        if response.truncated:
            raise ValueError("Device context response exceeded the read limit")
        validate_device_context(response.payload)
    except (ValueError, TypeError) as exc:
        result["error"] = {"code": "cloud_invalid_response", "http_status": response.status_code,
            "message": diagnostic(f"{exc}: " + diagnostic(response.payload, response.truncated))}
        return result, 4
    result.update(ok=True, data={"device_context": redact(response.payload)})
    return result, 0
