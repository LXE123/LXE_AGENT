from __future__ import annotations

import json
import time
import uuid
from typing import Any

from shared.infra.net import local_service_requests_session

class ZiniaoClientError(RuntimeError):
    pass


class ZiniaoClient:
    def __init__(self, socket_port: int, user_info: dict[str, str]):
        self._socket_port = int(socket_port)
        self._user_info = dict(user_info or {})
        self._base_url = f"http://127.0.0.1:{self._socket_port}"

    def _send(self, data: dict[str, Any]) -> dict[str, Any]:
        try:
            response = local_service_requests_session.post(
                self._base_url,
                data=json.dumps(data).encode("utf-8"),
                timeout=120,
            )
            response.raise_for_status()
            return dict(response.json() or {})
        except Exception as exc:
            raise ZiniaoClientError(f"failed to call Ziniao local HTTP control: {exc}") from exc

    def update_core(self) -> None:
        data = {"action": "updateCore", "requestId": str(uuid.uuid4()), **self._user_info}
        while True:
            result = self._send(data)
            status_code = result.get("statusCode")
            if status_code == 0:
                return
            if status_code == -10003:
                raise ZiniaoClientError("current Ziniao client version does not support updateCore")
            time.sleep(2)

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
