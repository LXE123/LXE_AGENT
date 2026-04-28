from __future__ import annotations

import os
import subprocess
import time
from typing import Any

from shared.config import config

from .ziniao_client import ZiniaoClient
from .ziniao_lifecycle import ZiniaoLifecycleManager


def _user_info() -> dict[str, str]:
    return {
        "company": str(getattr(config, "ZINIAO_COMPANY", "") or "").strip(),
        "username": str(getattr(config, "ZINIAO_USERNAME", "") or "").strip(),
        "password": str(getattr(config, "ZINIAO_PASSWORD", "") or "").strip(),
    }


def _client_path() -> str:
    return str(getattr(config, "ZINIAO_CLIENT_PATH", "") or "").strip()


def _control_port() -> int:
    safe_port = int(getattr(config, "ZINIAO_SOCKET_PORT", 0) or 0)
    if safe_port <= 0:
        raise RuntimeError("ZINIAO_SOCKET_PORT 未配置")
    return safe_port


def _build_client_command(control_port: int) -> list[str]:
    client_path = _client_path()
    if not client_path:
        raise RuntimeError("ZINIAO_CLIENT_PATH 未配置")
    if not os.path.exists(client_path):
        raise RuntimeError(f"ZINIAO_CLIENT_PATH 不存在: {client_path}")
    return [
        client_path,
        "--run_type=web_driver",
        "--ipc_type=http",
        f"--port={int(control_port)}",
    ]


class ZiniaoBrowserClient:
    def __init__(self) -> None:
        self.control_port = _control_port()
        self.client_path = _client_path()
        self.user_info = _user_info()
        self._client = ZiniaoClient(self.control_port, self.user_info)
        self._client_pid = 0

    @property
    def client(self) -> ZiniaoClient:
        return self._client

    def open_client(self) -> None:
        try:
            self._client.get_browser_list()
            resolved_pid = ZiniaoLifecycleManager.register_client(
                control_port=self.control_port,
                client_path=self.client_path,
                client_pid=self._client_pid,
            )
            if resolved_pid > 0:
                self._client_pid = resolved_pid
            return
        except Exception:
            pass

        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        process = subprocess.Popen(
            _build_client_command(self.control_port),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        launched_pid = int(getattr(process, "pid", 0) or 0)
        deadline = time.time() + 20
        last_error = ""
        while time.time() < deadline:
            try:
                self._client.get_browser_list()
                resolved_pid = ZiniaoLifecycleManager.register_client(
                    control_port=self.control_port,
                    client_path=self.client_path,
                    client_pid=launched_pid,
                )
                self._client_pid = resolved_pid or launched_pid
                return
            except Exception as exc:
                last_error = str(exc).strip()
                time.sleep(1)
        raise RuntimeError(last_error or "紫鸟客户端启动失败")

    def close_client(self) -> None:
        self.open_client()
        self._client.exit_client()

    def start_browser(self, browser_oauth: str) -> dict[str, Any]:
        self.open_client()
        result = self._client.start_browser(str(browser_oauth or "").strip())
        browser_ref = str(result.get("browserOauth") or browser_oauth or "").strip()
        if browser_ref:
            ZiniaoLifecycleManager.register_store(
                control_port=self.control_port,
                browser_ref=browser_ref,
                client_path=self.client_path,
                client_pid=self._client_pid,
            )
        return dict(result or {})

    def stop_browser(self, browser_oauth: str) -> None:
        self.open_client()
        safe_browser_oauth = str(browser_oauth or "").strip()
        if not safe_browser_oauth:
            raise RuntimeError("browser_oauth required")
        self._client.stop_browser(safe_browser_oauth)

    def get_browser_list(self) -> list[dict[str, Any]]:
        self.open_client()
        return [dict(item or {}) for item in list(self._client.get_browser_list() or [])]

    def get_running_info(self) -> list[dict[str, Any]]:
        self.open_client()
        return [dict(item or {}) for item in list(self._client.get_running_info() or [])]


__all__ = ["ZiniaoBrowserClient"]
