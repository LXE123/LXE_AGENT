import json

import pytest
import requests

from lxeskill import cli


def test_yacang_login_discovery_matches_list_and_describe(monkeypatch, capsys):
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "shangman-login")
    assert cli.main(["list"]) == 0
    result = json.loads(capsys.readouterr().out)
    entries = [entry for entry in result["data"]["commands"] if entry["command"].startswith("yacang login")]
    assert len(entries) == 1
    assert cli.main(["describe", "yacang", "login"]) == 0
    entry = json.loads(capsys.readouterr().out)["data"]
    assert entry == entries[0]
    assert entry["command"] == "yacang login"


@pytest.mark.parametrize("arguments", [
    [], ["unknown"], ["submit"], ["submit", "--challenge-id", "challenge-id"],
    ["submit", "--captcha-code", "Ab9x"],
    ["status", "--captcha-code", "Ab9x"],
])
def test_invalid_login_arguments_do_not_start_authentication(arguments, monkeypatch, capsys, tmp_path):
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path / "workspace"))
    monkeypatch.setenv("LXE_YACANG_MOBILE", "test-mobile")
    monkeypatch.setenv("LXE_YACANG_PASSWORD", "test-password")
    monkeypatch.setattr(requests.Session, "request", lambda *_args, **_kwargs: pytest.fail("invalid input must not contact the platform"))
    assert cli.main(["yacang", "login", *arguments]) != 0
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert not result["ok"]
    assert result["data"].get("error", result["error"])["code"] == "invalid_arguments"
    assert "Ab9x" not in json.dumps(result)


@pytest.mark.parametrize("action", [None, "status"])
def test_login_help_is_read_only_without_writable_state(action, monkeypatch, capsys, tmp_path):
    blocked = tmp_path / "state"
    blocked.write_text("untouched", encoding="utf-8")
    workspace = tmp_path / "workspace"
    monkeypatch.setenv("LXE_DATA_ROOT", str(blocked))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(workspace))
    arguments = ["yacang", "login", *([action] if action else []), "--help"]
    assert cli.main(arguments) == 0
    output = capsys.readouterr().out
    assert "lxeskill yacang login <action>" in output
    assert blocked.read_text(encoding="utf-8") == "untouched"
    assert not workspace.exists()
