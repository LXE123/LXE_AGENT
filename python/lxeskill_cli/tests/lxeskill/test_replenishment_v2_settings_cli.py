"""One real settings CLI round-trip and representative failed-save terminal."""
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
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)


def test_settings_cli_round_trip_and_internal_visibility():
    entry = load_catalog()["mabang_replenishment_v2_settings"]
    assert entry["visibility"] == "internal" and entry["exposed"] is False
    expected = {"peak_boost_enabled": True, "peak_boost_days": 0}
    for action, flags in [("save", ["--parameters", json.dumps(expected)]), ("read", [])]:
        child = subprocess.run([sys.executable, "-I", "-B", "-m", "lxeskill", *COMMAND, "--action", action, *flags],
                               capture_output=True, text=True, encoding="utf-8", timeout=30)
        assert child.returncode == 0, child.stderr or child.stdout
        terminal = json.loads(child.stdout)
        assert terminal["ok"] is True and terminal["data"]["data"] == expected and terminal["files"] == []


def test_failed_save_terminal_preserves_error_and_original_state(monkeypatch, capsys):
    expected = {"peak_boost_enabled": True, "peak_boost_days": 20}
    settings.save_parameters(expected)
    replace = settings._replace_text
    def fail(path, text):
        if path.name == "parameters.meta.json":
            raise OSError("fixture metadata publication failed")
        replace(path, text)
    monkeypatch.setattr(settings, "_replace_text", fail)
    assert cli.main([*COMMAND, "--action", "save", "--parameters",
                     json.dumps({"peak_boost_enabled": True, "peak_boost_days": 40})]) == cli.EXIT_BUSINESS
    terminal = json.loads(capsys.readouterr().out)
    assert terminal["ok"] is False and terminal["files"] == []
    assert "fixture metadata publication failed" in terminal["error"]["message"]
    assert settings.read_state() == expected
