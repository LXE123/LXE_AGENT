from __future__ import annotations

import json
import subprocess
import sys

import pytest

from lxeskill import cli
from lxeskill.business import load_catalog
from services.mabang.amazon.fba import replenishment_v2_settings as settings


COMMAND = ["replenish", "v2", "settings"]


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)


def test_settings_is_internal_and_not_another_model_entry(capsys):
    entry = load_catalog()["mabang_replenishment_v2_settings"]
    assert entry["command_path"] == COMMAND
    assert entry["visibility"] == "internal"
    assert entry["exposed"] is False
    assert entry["session_mode"] == "none"
    assert entry["owner_skills"] == []
    assert cli.main(["list"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert " ".join(COMMAND) not in {item["command"] for item in result["data"]["commands"]}


@pytest.mark.parametrize("flags", [
    [], ["--action", "unknown"], ["--action", "save"],
    ["--action", "read", "--parameters", "{}"],
    ["--action", "save", "--parameters", "{invalid"],
    ["--action", "save", "--parameters", "[]"],
    ["--action", "read", "--unexpected", "true"],
])
def test_invalid_arguments_never_reach_storage(flags, monkeypatch, capsys):
    def unexpected(*_args):
        pytest.fail("invalid arguments must not reach storage")

    monkeypatch.setattr(settings, "read_state", unexpected)
    monkeypatch.setattr(settings, "save_parameters", unexpected)
    assert cli.main([*COMMAND, *flags]) != 0
    record = json.loads(capsys.readouterr().out)
    assert record["type"] == "result" and record["ok"] is False
    assert record["error"]["message"]


def test_real_cli_round_trip_keeps_storage_format_and_actual_failure():
    def invoke(action, *flags, expected=0):
        child = subprocess.run(
            [sys.executable, "-I", "-B", "-X", "utf8", "-m", "lxeskill", *COMMAND, "--action", action, *flags],
            capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
        assert child.returncode == expected, child.stderr or child.stdout
        (record,) = [json.loads(line) for line in child.stdout.splitlines() if line.strip()]
        assert record["type"] == "result" and record["protocol_version"] == "1"
        assert record["command"] == " ".join(COMMAND) and record["files"] == []
        assert record["ok"] is (expected == 0)
        return record

    initial = invoke("read")["data"]["data"]
    assert initial["peak_boost_enabled"] is False
    assert settings.read_state() == initial
    path = settings.data_directory() / "parameters.json"
    path.write_text('{"peak_boost_enabled":false}', encoding="utf-8")
    legacy = invoke("read")["data"]["data"]
    assert legacy["peak_boost_enabled"] is False
    assert legacy == settings.read_state()
    for enabled in (False, True):
        parameters = {**initial, "peak_boost_enabled": enabled, "peak_boost_days": 20 if enabled else None}
        assert invoke("save", "--parameters", json.dumps(parameters))["data"]["data"] == parameters
        assert settings.read_state() == parameters
        assert invoke("read")["data"]["data"] == parameters
    for original, diagnostic in [
        ('{"peak_boost_enabled":"invalid"}', "ValueError: Amazon V2 旺季设置格式无效"),
        ("{invalid", "JSONDecodeError:"),
    ]:
        path.write_text(original, encoding="utf-8")
        failed = invoke("read", expected=4)
        assert diagnostic in failed["error"]["message"]
        assert failed["error"]["message"] == failed["data"]["exception"]
        assert path.read_text(encoding="utf-8") == original


def test_cli_preserves_utf8_errors_with_legacy_stdout():
    script = (
        "import sys; sys.stdout.reconfigure(encoding='cp1252'); "
        "from lxeskill.cli import main; "
        f"raise SystemExit(main({[*COMMAND, '--action', 'save', '--parameters', '{}']!r}))"
    )
    result = subprocess.run([sys.executable, "-I", "-B", "-c", script], capture_output=True, timeout=30)
    assert result.returncode == 4, result.stderr.decode("utf-8", errors="replace")
    error = json.loads(result.stdout.decode("utf-8"))
    assert error["type"] == "result" and error["ok"] is False
    assert error["error"]["message"] == "ValueError: peak_boost_enabled 必须是布尔值"
