from __future__ import annotations

import json
import uuid
from typing import Any

from shared.infra.net import local_service_requests_session

from .ziniao_trace import redact_value, trace_event


class ZiniaoClientError(RuntimeError):
    pass


def _response_trace_payload(action: str, result: dict[str, Any]) -> dict[str, Any]:
    safe_result = dict(result or {})
    payload: dict[str, Any] = {
        "statusCode": safe_result.get("statusCode"),
        "err": str(safe_result.get("err") or "").strip(),
    }
    if action == "getBrowserList":
        payload["browser_count"] = len(list(safe_result.get("browserList") or []))
        return payload
    if action == "getRunningInfo":
        payload["running_count"] = len(list(safe_result.get("browsers") or []))
        return payload
    if action == "startBrowser":
        for key in (
            "browserId",
            "browserName",
            "debuggingPort",
            "downloadPath",
            "browserPath",
            "core_type",
            "core_version",
            "launcherPage",
            "ipDetectionPage",
        ):
            if key in safe_result:
                payload[key] = safe_result.get(key)
        browser_oauth = safe_result.get("browserOauth")
        if browser_oauth:
            payload["store"] = redact_value(browser_oauth)
        return payload
    return payload


class ZiniaoClient:
    def __init__(self, socket_port: int, user_info: dict[str, str]):
        self._socket_port = int(socket_port)
        self._user_info = dict(user_info or {})
        self._base_url = f"http://127.0.0.1:{self._socket_port}"

    def _send(self, data: dict[str, Any]) -> dict[str, Any]:
        action = str((data or {}).get("action") or "").strip()
        trace_event(
            "client.request",
            action=action,
            has_browser_id=bool((data or {}).get("browserId")),
            store_id=(data or {}).get("browserOauth") or "",
        )
        try:
            response = local_service_requests_session.post(
                self._base_url,
                data=json.dumps(data).encode("utf-8"),
                timeout=120,
            )
            response.raise_for_status()
            result = dict(response.json() or {})
            trace_event(
                "client.response",
                action=action,
                status_code=result.get("statusCode"),
                err=str(result.get("err") or "").strip(),
                result=_response_trace_payload(action, result),
            )
            return result
        except Exception as exc:
            trace_event(
                "client.error",
                level="error",
                action=action,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise ZiniaoClientError(f"failed to call Ziniao local HTTP control: {exc}") from exc

    def get_browser_list(self) -> list[dict[str, Any]]:
        result = self._send({"action": "getBrowserList", "requestId": str(uuid.uuid4()), **self._user_info})
        if str(result.get("statusCode")) == "0":
            return list(result.get("browserList") or [])
        raise ZiniaoClientError(f"failed to load browser list: {result}")

    def get_running_info(self) -> list[dict[str, Any]]:
        result = self._send({"action": "getRunningInfo", "requestId": str(uuid.uuid4())})
        if str(result.get("statusCode")) == "0":
            return list(result.get("browsers") or [])
        raise ZiniaoClientError(f"failed to load running store info: {result}")

    def start_browser(
        self,
        store_oauth_or_id: str,
        *,
        headless: bool = False,
        privacy_mode: int = 0,
        read_only: int = 0,
    ) -> dict[str, Any]:
        payload = {
            "action": "startBrowser",
            "isWaitPluginUpdate": 0,
            "isHeadless": 1 if headless else 0,
            "requestId": str(uuid.uuid4()),
            "isWebDriverReadOnlyMode": int(read_only),
            "cookieTypeLoad": 0,
            "cookieTypeSave": 0,
            "runMode": "1",
            "isLoadUserPlugin": False,
            "pluginIdType": 1,
            "privacyMode": int(privacy_mode),
            "notPromptForDownload": 1,
            **self._user_info,
        }
        store_text = str(store_oauth_or_id or "").strip()
        if not store_text:
            raise ZiniaoClientError("store_oauth_or_id required")
        if store_text.isdigit():
            payload["browserId"] = store_text
        else:
            payload["browserOauth"] = store_text
        result = self._send(payload)
        if str(result.get("statusCode")) == "0":
            return result
        raise ZiniaoClientError(f"failed to start Ziniao browser: {result}")

    def stop_browser(self, browser_oauth_or_id: str) -> None:
        browser_ref = str(browser_oauth_or_id or "").strip()
        if not browser_ref:
            raise ZiniaoClientError("browser_oauth_or_id required")
        payload = {
            "action": "stopBrowser",
            "requestId": str(uuid.uuid4()),
            "duplicate": 0,
            **self._user_info,
        }
        if browser_ref.isdigit():
            payload["browserId"] = browser_ref
        else:
            payload["browserOauth"] = browser_ref
        result = self._send(payload)
        if str(result.get("statusCode")) != "0":
            raise ZiniaoClientError(f"failed to stop Ziniao browser: {result}")

    def exit_client(self) -> None:
        self._send({"action": "exit", "requestId": str(uuid.uuid4()), **self._user_info})
