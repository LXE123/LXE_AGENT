"""Machine-local browser selection; independent of desktop settings and accounts."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from shared.repository import state_root

HOST_URL_ENV = "LXE_AUTH_BROWSER_HOST_URL"
HOST_TOKEN_ENV = "LXE_AUTH_BROWSER_HOST_TOKEN"


def binding_file() -> Path:
    return state_root() / "config" / "mabang-auth-browser.json"


def host_connection() -> tuple[str, str] | None:
    url = os.environ.get(HOST_URL_ENV, "").strip()
    token = os.environ.get(HOST_TOKEN_ENV, "").strip()
    if not url and not token:
        return None
    parsed = urlsplit(url)
    if (not token or parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or not parsed.port or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("认证浏览器宿主配置无效：需要本机回环地址和认证令牌")
    return url.rstrip("/"), token


def read_binding() -> str | None:
    path = binding_file()
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError(f"浏览器绑定配置版本无效: {path}")
    executable = payload.get("executable")
    if not isinstance(executable, str) or not Path(executable).is_absolute():
        raise ValueError(f"浏览器绑定路径必须为绝对路径: {path}")
    return executable


def bound_executable() -> str:
    executable = read_binding()
    if not executable:
        raise ValueError('未绑定认证浏览器，请运行 lxeskill auth browser bind --executable "<Chrome/Edge 可执行文件绝对路径>"')
    if not Path(executable).is_file():
        raise FileNotFoundError(f"绑定的浏览器不存在，请重新绑定: {executable}")
    return executable


def _probe(executable: str) -> str:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True, timeout=30000)
        try:
            context = browser.new_context()
            try:
                page = context.new_page()
                if page.evaluate("() => 6 * 7") != 42:
                    raise RuntimeError("浏览器空白页控制检查返回异常")
                return browser.version
            finally:
                context.close()
        finally:
            browser.close()


def bind_browser(executable: str) -> dict:
    candidate = Path(executable).expanduser()
    if not candidate.is_absolute():
        raise ValueError("请提供 Chrome/Edge 可执行文件的绝对路径")
    candidate = candidate.resolve(strict=True)
    if not candidate.is_file():
        raise ValueError("绑定目标必须为浏览器可执行文件；macOS 请使用 .app/Contents/MacOS/ 下的程序")
    version = _probe(str(candidate))
    path = binding_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump({"version": 1, "executable": str(candidate)}, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return {"bound": True, "executable": str(candidate), "browser_version": version}


def browser_status() -> dict:
    executable = read_binding()
    host = host_connection()
    return {
        "bound": executable is not None,
        "executable": executable,
        "executable_exists": bool(executable and Path(executable).is_file()),
        "provider": "host" if host else "system" if executable else "unconfigured",
    }


def unbind_browser() -> dict:
    binding_file().unlink(missing_ok=True)
    return {"bound": False}
