from __future__ import annotations

import json
import inspect
from types import SimpleNamespace

import pytest

from browser_auth_service import client as browser_auth_client
from browser_auth_service import main as browser_auth_main
from browser_auth_service import service as browser_auth_service


def test_browser_auth_python_api_has_no_compatibility_parameters() -> None:
    assert list(inspect.signature(browser_auth_service.refresh_auth).parameters) == ["account"]
    assert list(inspect.signature(browser_auth_service.read_auth).parameters) == ["account"]
    assert list(inspect.signature(browser_auth_client.refresh_auth).parameters) == ["account"]
    assert list(inspect.signature(browser_auth_client.read_auth).parameters) == ["account"]


def test_browser_auth_main_writes_only_one_final_json_line_to_stdout(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        browser_auth_service,
        "refresh_auth",
        lambda account="": {
            "success": True,
            "account": account,
            "source": "refresh",
            "final_url": "https://wms.private.mabangerp.com/",
            "state_written": True,
        },
    )
    monkeypatch.setattr(browser_auth_main.sys, "argv", ["browser_auth_service", "refresh", "--account", "account-a"])

    assert browser_auth_main.main() == 0
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0])["source"] == "refresh"


def test_refresh_auth_sync_uses_single_refresh_command_and_inherits_stderr(monkeypatch) -> None:
    calls: list[tuple[list[str], dict]] = []

    def fake_run(command: list[str], **kwargs):
        calls.append((command, kwargs))
        payload = {
            "success": True,
            "account": "account-a",
            "source": "refresh",
            "final_url": "https://wms.private.mabangerp.com/",
            "state_written": True,
        }
        return SimpleNamespace(returncode=0, stdout=json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr(browser_auth_client.subprocess, "run", fake_run)

    result = browser_auth_client.refresh_auth_sync("account-a")

    command, kwargs = calls[0]
    assert command[-3:] == ["refresh", "--account", "account-a"]
    assert "ensure" not in command
    assert "--scope" not in command
    assert "--force-refresh" not in command
    assert "stderr" not in kwargs
    assert kwargs["stdout"] is browser_auth_client.subprocess.PIPE
    assert kwargs["env"]["PYTHONUNBUFFERED"] == "1"
    assert result["state_written"] is True


def test_refresh_auth_sync_preserves_structured_real_error(monkeypatch) -> None:
    def fake_run(command: list[str], **kwargs):
        payload = {
            "success": False,
            "stage": "wms",
            "current_url": "https://private.mabangerp.com/",
            "exception_type": "Error",
            "message": "Locator.click: Element is not visible",
        }
        return SimpleNamespace(returncode=1, stdout=json.dumps(payload).encode("utf-8"))

    monkeypatch.setattr(browser_auth_client.subprocess, "run", fake_run)

    with pytest.raises(browser_auth_client.BrowserAuthClientError) as captured:
        browser_auth_client.refresh_auth_sync()

    message = str(captured.value)
    assert "stage=wms" in message
    assert "current_url=https://private.mabangerp.com/" in message
    assert "Locator.click: Element is not visible" in message


def test_read_auth_sync_uses_direct_complete_file_reader(monkeypatch) -> None:
    calls: list[dict] = []

    def fake_read_auth(**kwargs):
        calls.append(kwargs)
        return {
            "success": True,
            "source": "file",
            "free_token": "fresh",
            "wms_cookie_header": "WMSID=fresh",
            "cookies_by_domain": {},
        }

    monkeypatch.setattr(browser_auth_service, "read_auth", fake_read_auth)

    result = browser_auth_client.read_auth_sync("account-a")

    assert result["source"] == "file"
    assert calls == [{"account": "account-a"}]
