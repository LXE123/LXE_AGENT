"""Settings validation and failed writes use actual CLI processes and disk state."""
import errno
import json
import os

import pytest

from replenishment_cases import cli
from services.mabang.amazon.fba import replenishment_v2_settings as settings


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)


def command(action, parameters=None, expected=0):
    options = [] if parameters is None else ["--parameters", json.dumps(parameters)]
    return cli("replenish", "v2", "settings", "--action", action, *options, expected=expected)


def test_settings_survive_process_restart_and_keep_disabled_days():
    for enabled, days in ((True, 0), (True, 120), (False, 20), (False, None)):
        parameters = {"peak_boost_enabled": enabled, "peak_boost_days": days}
        assert command("save", parameters)["ok"]
        read = command("read")
        assert read["ok"] and read["data"]["data"] == parameters


@pytest.mark.parametrize("changes", [
    {"peak_boost_enabled": "false"}, {"peak_boost_days": None}, {"peak_boost_days": True},
    {"peak_boost_days": "20"}, {"peak_boost_days": -1}, {"peak_boost_days": 121},
    {"peak_boost_days": 1.5}, {"unexpected": 1},
])
def test_invalid_save_reports_failure_and_keeps_previous_value(changes):
    previous = {"peak_boost_enabled": True, "peak_boost_days": 20}
    settings.save_parameters(previous)
    result = command("save", {**previous, **changes}, expected=4)
    assert not result["ok"] and result["error"]["message"] and result["files"] == []
    assert settings.read_state() == previous


def test_corrupt_file_is_reported_and_not_silently_replaced():
    settings.read_state()
    path = settings.data_directory() / "parameters.json"
    path.write_text("{broken", encoding="utf-8")
    result = command("read", expected=4)
    assert "格式无效" in result["error"]["message"]
    assert path.read_text(encoding="utf-8") == "{broken"


@pytest.mark.skipif(os.name == "nt" or (hasattr(os, "geteuid") and os.geteuid() == 0),
                    reason="Requires POSIX permissions for an actual write failure")
def test_failed_write_keeps_original_file_and_exposes_os_error():
    previous = {"peak_boost_enabled": True, "peak_boost_days": 20}
    settings.save_parameters(previous)
    root = settings.data_directory()
    original = (root / "parameters.json").read_bytes()
    root.chmod(0o500)
    try:
        result = command("save", {**previous, "peak_boost_days": 40}, expected=4)
    finally:
        root.chmod(0o700)
    assert os.strerror(errno.EACCES) in result["error"]["message"]
    assert str(root) in result["error"]["message"]
    assert (root / "parameters.json").read_bytes() == original
    assert settings.read_state() == previous
