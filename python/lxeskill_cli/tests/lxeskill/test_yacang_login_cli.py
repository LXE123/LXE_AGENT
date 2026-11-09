import json

import pytest

from lxeskill import cli
from services.commands.yacang import login


def test_yacang_login_discovery_exposes_one_command_with_action_contract(monkeypatch, capsys):
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "shangman-login")
    assert cli.main(["list"]) == 0
    result = json.loads(capsys.readouterr().out)
    entries = [entry for entry in result["data"]["commands"] if entry["command"].startswith("yacang login")]
    assert len(entries) == 1
    assert cli.main(["describe", "yacang", "login"]) == 0
    entry = json.loads(capsys.readouterr().out)["data"]
    assert entry == entries[0]
    assert entry["command"] == "yacang login"
    schema = entry["input_schema"]
    assert schema["required"] == ["action"]
    assert schema["properties"]["action"]["enum"] == ["prepare", "submit", "status", "clear"]
    assert schema["allOf"][0]["then"]["required"] == ["challenge_id", "captcha_code"]
    assert entry["artifact_paths"] == [{"field": "image_path", "role": "model_input"}]


@pytest.mark.parametrize("arguments", [
    [], ["unknown"], ["submit"], ["submit", "--challenge-id", "challenge-id"],
    ["submit", "--captcha-code", "Ab9x"],
    ["status", "--captcha-code", "Ab9x"],
])
def test_invalid_login_arguments_do_not_start_authentication(arguments, monkeypatch, capsys):
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    monkeypatch.setattr(login, "login_action", lambda *_: pytest.fail("invalid input must not start authentication"))
    assert cli.main(["yacang", "login", *arguments]) != 0
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert not result["ok"]
    assert result["data"].get("error", result["error"])["code"] == "invalid_arguments"
    assert "Ab9x" not in json.dumps(result)


@pytest.mark.parametrize("action", [None, "prepare", "submit", "status", "clear"])
def test_login_help_is_read_only_and_explains_actions(action, monkeypatch, capsys):
    monkeypatch.setattr(cli, "_run_entry", lambda *_: pytest.fail("help must not run authentication"))
    arguments = ["yacang", "login", *([action] if action else []), "--help"]
    assert cli.main(arguments) == 0
    output = capsys.readouterr().out
    assert "lxeskill yacang login <action>" in output
    assert "prepare, submit, status, clear" in output
    assert "仅 submit 使用，必填" in output
