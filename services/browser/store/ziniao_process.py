from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import time
from pathlib import Path
from typing import Any

from shared.infra.net import external_requests_session
from shared.logging import logger


_WINDOWS_DRIVER_CONFIG_URL = "https://cdn-superbrowser-attachment.ziniao.com/webdriver/exe_32/config.json"
_MAC_X64_DRIVER_CONFIG_URL = "https://cdn-superbrowser-attachment.ziniao.com/webdriver/mac/x64/config.json"
_MAC_ARM64_DRIVER_CONFIG_URL = "https://cdn-superbrowser-attachment.ziniao.com/webdriver/mac/arm64/config.json"
_VALID_BROWSER_VERSIONS = {"v5", "v6"}


def normalize_browser_version(version: str) -> str:
    safe_version = str(version or "").strip().lower()
    if safe_version not in _VALID_BROWSER_VERSIONS:
        raise RuntimeError("ZINIAO_BROWSER_VERSION must be v5 or v6")
    return safe_version


def encrypt_sha1(file_path: str) -> str:
    digest = hashlib.sha1()
    with open(file_path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _driver_config_url() -> str | None:
    system = platform.system()
    if system == "Windows":
        return _WINDOWS_DRIVER_CONFIG_URL
    if system == "Darwin":
        arch = platform.machine()
        if arch == "x86_64":
            return _MAC_X64_DRIVER_CONFIG_URL
        if arch == "arm64":
            return _MAC_ARM64_DRIVER_CONFIG_URL
        raise RuntimeError(f"Unsupported Mac architecture: {arch}")
    if system == "Linux":
        return None
    raise RuntimeError(f"Unsupported system for Ziniao driver download: {system}")


def _load_driver_config(config_url: str) -> list[dict[str, Any]]:
    response = external_requests_session.get(config_url, timeout=60)
    try:
        if int(getattr(response, "status_code", 0) or 0) != 200:
            raise RuntimeError(f"Failed to download driver config, status={response.status_code}")
        payload = json.loads(str(getattr(response, "text", "") or ""))
    finally:
        close = getattr(response, "close", None)
        if callable(close):
            close()

    if not isinstance(payload, list):
        raise RuntimeError("Invalid Ziniao driver config: expected a list")
    return [dict(item or {}) for item in payload]


def download_file(url: str, save_path: str) -> None:
    safe_url = str(url or "").strip()
    if not safe_url:
        raise RuntimeError("Driver download url is required")

    destination = Path(save_path).expanduser()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp_path = destination.with_name(f"{destination.name}.tmp-{os.getpid()}")

    response = external_requests_session.get(safe_url, stream=True, timeout=120)
    try:
        if int(getattr(response, "status_code", 0) or 0) != 200:
            raise RuntimeError(f"Failed to download driver file, status={response.status_code}")
        with open(temp_path, "wb") as file:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    file.write(chunk)
        os.replace(temp_path, destination)
    except Exception:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        raise
    finally:
        close = getattr(response, "close", None)
        if callable(close):
            close()

    logger.info("[Ziniao] driver file downloaded: %s", destination)


def _driver_filename(item: dict[str, Any], *, system: str) -> str:
    filename = str(item.get("name") or "").strip()
    if not filename:
        raise RuntimeError(f"Invalid Ziniao driver config item: {item}")
    if system == "Windows":
        filename += ".exe"
    return filename


def download_driver(webdriver_path: str) -> None:
    config_url = _driver_config_url()
    if config_url is None:
        logger.info("[Ziniao] Linux uses embedded webdriver; skip driver download")
        return

    safe_webdriver_path = str(webdriver_path or "").strip()
    if not safe_webdriver_path:
        raise RuntimeError("ZINIAO_WEBDRIVER_PATH is required")
    driver_root = Path(safe_webdriver_path).expanduser()
    driver_root.mkdir(parents=True, exist_ok=True)

    system = platform.system()
    for item in _load_driver_config(config_url):
        filename = _driver_filename(item, system=system)
        expected_sha1 = str(item.get("sha1") or "").strip().lower()
        download_url = str(item.get("url") or "").strip()
        local_file_path = driver_root / filename

        if local_file_path.exists() and expected_sha1:
            file_sha1 = encrypt_sha1(str(local_file_path))
            if file_sha1 == expected_sha1:
                logger.info("[Ziniao] driver exists and sha1 matched: %s", filename)
                continue
            logger.info("[Ziniao] driver sha1 mismatch, redownloading: %s", filename)
        elif local_file_path.exists():
            logger.info("[Ziniao] driver exists but config has no sha1; redownloading: %s", filename)
        else:
            logger.info("[Ziniao] driver missing, downloading: %s", filename)

        download_file(download_url, str(local_file_path))
        if expected_sha1 and encrypt_sha1(str(local_file_path)) != expected_sha1:
            raise RuntimeError(f"Downloaded driver sha1 mismatch: {filename}")
        if system == "Darwin":
            subprocess.run(["chmod", "+x", str(local_file_path)], check=False)


def kill_process(version: str) -> None:
    safe_version = normalize_browser_version(version)
    system = platform.system()

    if system == "Windows":
        process_name = "SuperBrowser.exe" if safe_version == "v5" else "ziniao.exe"
        cmd = ["taskkill", "/f", "/t", "/im", process_name]
    elif system == "Darwin":
        cmd = ["killall", "ziniao"]
    elif system == "Linux":
        cmd = ["killall", "ziniaobrowser"]
    else:
        raise RuntimeError(f"Unsupported system for Ziniao process cleanup: {system}")

    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if int(getattr(result, "returncode", 1) or 0) == 0:
        logger.info("[Ziniao] old client process cleaned: %s", cmd)
    else:
        logger.info("[Ziniao] old client process not found or already exited: %s", cmd)
    time.sleep(3)


__all__ = [
    "download_driver",
    "download_file",
    "encrypt_sha1",
    "kill_process",
    "normalize_browser_version",
]
