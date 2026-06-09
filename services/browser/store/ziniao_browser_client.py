from __future__ import annotations

import os
import subprocess
import time
from typing import Any

from shared.logging import logger

from . import ziniao_config as ziniao_settings
from .ziniao_client import ZiniaoClient, ZiniaoClientError
from .ziniao_lifecycle import ZiniaoLifecycleManager
from .ziniao_process import download_driver, kill_process, normalize_browser_version


def _user_info() -> dict[str, str]:
    return {
        "company": str(ziniao_settings.ZINIAO_COMPANY or "").strip(),
        "username": str(ziniao_settings.ZINIAO_USERNAME or "").strip(),
        "password": str(ziniao_settings.ZINIAO_PASSWORD or "").strip(),
    }


def _client_path() -> str:
    return str(ziniao_settings.ZINIAO_CLIENT_PATH or "").strip()


def _control_port() -> int:
    safe_port = int(ziniao_settings.ZINIAO_SOCKET_PORT or 0)
    if safe_port <= 0:
        raise RuntimeError("ZINIAO_SOCKET_PORT 未配置")
    return safe_port


def _build_client_command(control_port: int) -> list[str]:
    client_path = _client_path()
    if not client_path:
        raise RuntimeError("ZINIAO_CLIENT_PATH 未配置")
    if not os.path.exists(client_path):
        raise RuntimeError(f"ZINIAO_CLIENT_PATH 不存在: {client_path}")
    if not os.path.isfile(client_path):
        raise RuntimeError(f"ZINIAO_CLIENT_PATH 不是可执行文件: {client_path}")
    if os.name == "nt" and not client_path.lower().endswith(".exe"):
        raise RuntimeError(f"ZINIAO_CLIENT_PATH 不是 Windows exe 文件: {client_path}")
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
        self._client_ready = False

    @property
    def client(self) -> ZiniaoClient:
        return self._client

    def _prepare_client_startup(self) -> None:
        raw_version = ziniao_settings.ZINIAO_BROWSER_VERSION or os.getenv("ZINIAO_BROWSER_VERSION", "v6")
        browser_version = normalize_browser_version(
            str(raw_version)
        )
        download_driver(str(ziniao_settings.ZINIAO_WEBDRIVER_PATH or "").strip())
        kill_process(browser_version)

    def _mark_client_ready(self, *, client_pid: int = 0) -> None:
        resolved_pid = ZiniaoLifecycleManager.register_client(
            control_port=self.control_port,
            client_path=self.client_path,
            client_pid=client_pid or self._client_pid,
        )
        if resolved_pid > 0:
            self._client_pid = resolved_pid
        elif client_pid > 0:
            self._client_pid = client_pid
        self._client_ready = True

    def _probe_client(self) -> bool:
        try:
            self._client.get_browser_list()
            self._mark_client_ready()
            return True
        except Exception:
            self._client_ready = False
            return False

    def open_client(self, *, allow_start: bool = True) -> bool:
        if self._client_ready:
            return True
        if self._probe_client():
            return True
        if not allow_start:
            return False

        self._prepare_client_startup()

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
                self._mark_client_ready(client_pid=launched_pid)
                return True
            except Exception as exc:
                last_error = str(exc).strip()
                time.sleep(1)
        raise RuntimeError(last_error or "紫鸟客户端启动失败")

    def close_client(self) -> None:
        if not self.open_client(allow_start=False):
            logger.info("[Ziniao] close_client skipped: local client API unavailable")
            return
        try:
            self._client.exit_client()
        except ZiniaoClientError as exc:
            logger.info("[Ziniao] close_client skipped: local client API unavailable: %s", exc)
            self._client_ready = False

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
        safe_browser_oauth = str(browser_oauth or "").strip()
        if not safe_browser_oauth:
            raise RuntimeError("browser_oauth required")
        if not self.open_client(allow_start=False):
            logger.info("[Ziniao] stop_browser skipped: local client API unavailable: %s", safe_browser_oauth)
            return
        try:
            self._client.stop_browser(safe_browser_oauth)
        except ZiniaoClientError as exc:
            logger.info("[Ziniao] stop_browser skipped: local client API unavailable: %s", exc)
            self._client_ready = False

    def get_browser_list(self) -> list[dict[str, Any]]:
        self.open_client()
        return [dict(item or {}) for item in list(self._client.get_browser_list() or [])]

    def get_running_info(self) -> list[dict[str, Any]]:
        self.open_client()
        return [dict(item or {}) for item in list(self._client.get_running_info() or [])]


__all__ = ["ZiniaoBrowserClient"]
