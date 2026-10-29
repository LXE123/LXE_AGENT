"""Exercise auth diagnostics through both public CLI failure paths."""
from __future__ import annotations

import io
import json
from contextlib import redirect_stdout
from types import SimpleNamespace

import pytest

from browser_auth_service import client, host, main, service
from lxeskill import cli
from test_browser_auth_service_clean_refresh import _install_refresh_route
from test_browser_auth_service_fba_token import FakeFrame


@pytest.mark.parametrize("provider", ["electron_host", "bound_chromium"])
@pytest.mark.parametrize("business_command", [False, True])
def test_real_storage_error_and_environment_reach_terminal(
    provider, business_command, monkeypatch, tmp_path, capsys,
):
    state = tmp_path / "state.json"
    extract_token = service._extract_token
    events, context, _ = _install_refresh_route(monkeypatch, state)
    monkeypatch.setattr(service.mabang_settings, "MABANG_ACCOUNT", "account-a")
    monkeypatch.setattr(service.mabang_settings, "MABANG_PASSWORD", "account-password")
    monkeypatch.setattr(service, "host_connection", lambda: ("http://127.0.0.1:1", "host-secret") if provider == "electron_host" else None)
    monkeypatch.setattr(host, "HostContext", lambda connection, headless: context)

    cause = host.HostBrowserError({
        "exception_type": "SecurityError",
        "message": "Failed to read localStorage: Access is denied; password=account-password",
    })
    frame = FakeFrame(service.FBA_LOGISTICS_TOKEN_ORIGIN + "/dashboard?ticket=private-ticket", [cause])

    def read_storage(page, origin, key):
        page.main_frame = frame
        page.frames = [frame]
        return extract_token(page, origin, key, wait_seconds=0)

    monkeypatch.setattr(service, "_extract_token", read_storage)
    subprocess_payloads = []

    def run_auth_subprocess(command, **kwargs):
        # Execute the real auth entrypoint/JSON serializer with fixture pages;
        # only the process boundary is in-process for deterministic testing.
        output = io.StringIO()
        with monkeypatch.context() as scoped, redirect_stdout(output):
            scoped.setattr(main.sys, "argv", ["browser_auth_service", *command[3:]])
            code = main.main()
        payload = json.loads(output.getvalue())
        subprocess_payloads.append(payload)
        return SimpleNamespace(returncode=code, stdout=output.getvalue().encode())

    monkeypatch.setattr(client.subprocess, "run", run_auth_subprocess)
    arguments = ["mabang", "delivery", "export", "--delivery-no", "SP123"] if business_command else ["mabang", "auth", "refresh"]
    assert cli.main(arguments) == cli.EXIT_BUSINESS
    (terminal,) = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert terminal["ok"] is False
    assert terminal["files"] == []
    message = terminal["error"]["message"]
    assert "stage=fba_delivery" in message
    assert "SecurityError" in message
    assert "Failed to read localStorage: Access is denied" in message
    assert f'"provider": "{provider}"' in message
    assert '"shares_ziniao_session": false' in message
    assert '"reason": "storage_read_failed"' in message
    assert '"storage_key": "freeToken"' in message
    assert "account-password" not in message
    assert "private-ticket" not in message
    assert events.count("login") == 1
    assert "wms" not in events
    assert context.storage_state_calls == 0
    assert not state.exists()
    if business_command:
        assert len(subprocess_payloads) == 1
        assert subprocess_payloads[0]["auth_environment"]["provider"] == provider
        assert subprocess_payloads[0]["details"]["last_read_error"]["exception_type"] == "SecurityError"
        assert terminal["data"]["exception"] == message
    else:
        assert subprocess_payloads == []


def test_nested_stage_error_keeps_selected_browser(monkeypatch, tmp_path):
    state = tmp_path / "state.json"
    _install_refresh_route(monkeypatch, state, wms_error=service.BrowserAuthRefreshError(
        stage="wms", current_url=service.FBA_HOME_URL, cause=RuntimeError("WMS navigation refused"),
    ))
    monkeypatch.setattr(service, "host_connection", lambda: None)
    with pytest.raises(service.BrowserAuthRefreshError) as captured:
        service.refresh_auth()
    payload = captured.value.to_payload()
    assert payload["stage"] == "wms"
    assert payload["message"] == "WMS navigation refused"
    assert payload["auth_environment"]["provider"] == "bound_chromium"
