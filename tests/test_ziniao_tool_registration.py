from __future__ import annotations

import pytest

from agent_runtime.tool_registry import UnifiedToolRegistry, register_browser_tools
from services.browser.store import ziniao_config


def _configure_ziniao(
    monkeypatch,
    *,
    client_path: str,
    company: str = "company",
    username: str = "user",
    password: str = "password",
    system: str = "Windows",
) -> None:
    monkeypatch.setattr(ziniao_config.platform, "system", lambda: system)
    monkeypatch.setattr(ziniao_config, "ZINIAO_CLIENT_PATH", client_path)
    monkeypatch.setattr(ziniao_config, "ZINIAO_COMPANY", company)
    monkeypatch.setattr(ziniao_config, "ZINIAO_USERNAME", username)
    monkeypatch.setattr(ziniao_config, "ZINIAO_PASSWORD", password)


def _registered_tool_names() -> set[str]:
    registry = UnifiedToolRegistry()
    register_browser_tools(registry)
    return set(registry.all_names())


def test_ziniao_tools_hidden_when_client_path_missing(monkeypatch):
    _configure_ziniao(monkeypatch, client_path="")

    assert _registered_tool_names().isdisjoint({"ziniao_browser", "ziniao_page"})


def test_ziniao_tools_hidden_when_client_path_does_not_exist(monkeypatch, tmp_path):
    _configure_ziniao(monkeypatch, client_path=str(tmp_path / "missing.exe"))

    assert _registered_tool_names().isdisjoint({"ziniao_browser", "ziniao_page"})


def test_ziniao_tools_hidden_when_client_path_is_not_exe(monkeypatch, tmp_path):
    client_path = tmp_path / "ziniao.txt"
    client_path.write_text("fake", encoding="utf-8")
    _configure_ziniao(monkeypatch, client_path=str(client_path))

    assert _registered_tool_names().isdisjoint({"ziniao_browser", "ziniao_page"})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("company", ""),
        ("username", ""),
        ("password", ""),
    ],
)
def test_ziniao_tools_hidden_when_login_profile_incomplete(monkeypatch, tmp_path, field, value):
    client_path = tmp_path / "ziniao.exe"
    client_path.write_text("fake", encoding="utf-8")
    kwargs = {
        "client_path": str(client_path),
        "company": "company",
        "username": "user",
        "password": "password",
    }
    kwargs[field] = value
    _configure_ziniao(monkeypatch, **kwargs)

    assert _registered_tool_names().isdisjoint({"ziniao_browser", "ziniao_page"})


def test_ziniao_tools_hidden_on_non_windows_even_with_exe(monkeypatch, tmp_path):
    client_path = tmp_path / "ziniao.exe"
    client_path.write_text("fake", encoding="utf-8")
    _configure_ziniao(monkeypatch, client_path=str(client_path), system="Darwin")

    assert _registered_tool_names().isdisjoint({"ziniao_browser", "ziniao_page"})


def test_ziniao_tools_registered_when_windows_exe_and_login_profile_present(monkeypatch, tmp_path):
    client_path = tmp_path / "ziniao.exe"
    client_path.write_text("fake", encoding="utf-8")
    _configure_ziniao(monkeypatch, client_path=str(client_path))

    assert {"ziniao_browser", "ziniao_page"}.issubset(_registered_tool_names())
