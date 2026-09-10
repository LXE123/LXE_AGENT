import json
from pathlib import Path

import pytest

from browser_auth_service import binding, service
from lxeskill import cli


@pytest.fixture(autouse=True)
def independent_config(tmp_path, monkeypatch):
    monkeypatch.setattr(binding, "state_root", lambda: tmp_path)
    monkeypatch.delenv(binding.HOST_URL_ENV, raising=False)
    monkeypatch.delenv(binding.HOST_TOKEN_ENV, raising=False)


def test_bind_probe_success_then_replace_and_unbind_preserves_state(tmp_path, monkeypatch):
    executable = tmp_path / "中文 Chrome program"
    executable.write_text("test executable")
    calls = []
    monkeypatch.setattr(binding, "_probe", lambda path: calls.append(path) or "152.0")
    state = tmp_path / "state.json"
    state.write_text("cached state")
    result = binding.bind_browser(str(executable))
    assert result["browser_version"] == "152.0"
    assert calls == [str(executable)]
    assert json.loads(binding.binding_file().read_text()) == {"version": 1, "executable": str(executable)}
    assert binding.bound_executable() == str(executable)
    assert binding.browser_status()["provider"] == "system"
    monkeypatch.setattr(binding, "_probe", lambda path: pytest.fail("status must not launch"))
    assert binding.browser_status()["executable_exists"]
    binding.unbind_browser()
    binding.unbind_browser()
    assert state.read_text() == "cached state"
    assert binding.browser_status()["provider"] == "unconfigured"


def test_failed_rebinding_preserves_original(tmp_path, monkeypatch):
    first, second = tmp_path / "first", tmp_path / "second"
    first.touch()
    second.touch()
    monkeypatch.setattr(binding, "_probe", lambda path: "1")
    binding.bind_browser(str(first))
    before = binding.binding_file().read_bytes()
    def failed(path):
        raise RuntimeError("Browser closed: enterprise policy denied launch")
    monkeypatch.setattr(binding, "_probe", failed)
    with pytest.raises(RuntimeError, match="enterprise policy denied"):
        binding.bind_browser(str(second))
    assert binding.binding_file().read_bytes() == before
    first.unlink()
    assert binding.browser_status()["executable_exists"] is False
    with pytest.raises(FileNotFoundError, match="重新绑定"):
        binding.bound_executable()


@pytest.mark.parametrize("path", ["relative/chrome", ""])
def test_bind_requires_absolute_file(path):
    with pytest.raises(ValueError, match="绝对路径"):
        binding.bind_browser(path)


def test_bind_directory_is_rejected_without_probe(tmp_path, monkeypatch):
    monkeypatch.setattr(binding, "_probe", lambda path: pytest.fail("directory must not launch"))
    with pytest.raises(ValueError, match="可执行文件"):
        binding.bind_browser(str(tmp_path))


def test_host_selected_only_when_injected_and_never_exposes_connection(monkeypatch):
    monkeypatch.setenv(binding.HOST_URL_ENV, "http://127.0.0.1:43210")
    monkeypatch.setenv(binding.HOST_TOKEN_ENV, "private-host-token")
    assert binding.host_connection() == ("http://127.0.0.1:43210", "private-host-token")
    status = binding.browser_status()
    assert status["provider"] == "host"
    assert "43210" not in json.dumps(status)
    assert "private-host-token" not in json.dumps(status)


@pytest.mark.parametrize("url", ["https://127.0.0.1:10", "http://example.org:10", "http://127.0.0.1", "http://u:p@127.0.0.1:10", "http://127.0.0.1:10/?token=x"])
def test_invalid_host_configuration_does_not_fall_back(url, monkeypatch):
    monkeypatch.setenv(binding.HOST_URL_ENV, url)
    monkeypatch.setenv(binding.HOST_TOKEN_ENV, "secret")
    with pytest.raises(ValueError):
        binding.host_connection()


def test_cli_binding_commands_do_not_refresh_or_require_credentials(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(service, "refresh_auth", lambda **kwargs: pytest.fail("binding is not refresh"))
    monkeypatch.setattr(binding, "_probe", lambda path: "152.0")
    executable = tmp_path / "浏览器 with spaces"
    executable.touch()
    for arguments in (["bind", "--executable", str(executable)], ["status"], ["unbind"]):
        assert cli.main(["auth", "browser", *arguments]) == 0
        payload = json.loads(capsys.readouterr().out)
        assert payload["ok"] is True
        assert payload["command"] == "auth browser " + arguments[0]


def test_host_refresh_uses_same_complete_route_without_playwright(tmp_path, monkeypatch):
    from test_browser_auth_service_clean_refresh import _install_refresh_route
    from browser_auth_service import host

    state = tmp_path / "state.json"
    events, context, _ = _install_refresh_route(monkeypatch, state)
    monkeypatch.setattr(service, "host_connection", lambda: ("http://127.0.0.1:1", "token"))
    monkeypatch.setattr(host, "HostContext", lambda connection, headless: context)
    monkeypatch.setattr(service, "sync_playwright", lambda: pytest.fail("host must not start Playwright"))
    assert service.refresh_auth()["state_written"]
    assert events == ["login", "inventory", "fba", "free-token", "wms", "storage-state", "context-close"]
    assert service._require_complete_auth_material(json.loads(state.read_text()))


def test_host_failure_has_no_system_browser_fallback(tmp_path, monkeypatch):
    from test_browser_auth_service_clean_refresh import _install_refresh_route
    from browser_auth_service import host

    state = tmp_path / "state.json"
    _install_refresh_route(monkeypatch, state)
    monkeypatch.setattr(service, "host_connection", lambda: ("http://127.0.0.1:1", "token"))
    def refused(*args, **kwargs):
        raise ConnectionRefusedError("connection refused by host")
    monkeypatch.setattr(host, "HostContext", refused)
    monkeypatch.setattr(service, "sync_playwright", lambda: pytest.fail("no fallback"))
    with pytest.raises(service.BrowserAuthRefreshError, match="connection refused by host"):
        service.refresh_auth()
    assert not state.exists()
