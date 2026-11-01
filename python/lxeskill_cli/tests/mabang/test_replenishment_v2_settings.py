"""Persistent settings: first use, saved values and invalid input."""
from __future__ import annotations

import json
import pytest
from services.mabang.amazon.fba import replenishment_v2_settings as settings


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))


def test_first_use_is_off_without_default_days():
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": None}


@pytest.mark.parametrize("enabled,days", [(False, None), (False, 20), (True, 0), (True, 20), (True, 120)])
def test_save_reload_retains_settings(enabled, days):
    expected = {"peak_boost_enabled": enabled, "peak_boost_days": days}
    assert settings.save_parameters(expected) == settings.read_state() == expected
    assert json.loads((settings.data_directory() / "parameters.json").read_bytes()) == expected


@pytest.mark.parametrize("parameters", [
    {"peak_boost_enabled": True, "peak_boost_days": None},
    {"peak_boost_enabled": False, "peak_boost_days": 121},
    {"peak_boost_enabled": True, "peak_boost_days": -1},
    {"peak_boost_enabled": True, "peak_boost_days": True},
    {"peak_boost_enabled": "false", "peak_boost_days": 20},
    {"peak_boost_enabled": True, "peak_boost_days": "20"},
    {"peak_boost_enabled": True},
    {"peak_boost_enabled": False, "peak_boost_days": None, "unexpected": 1},
])
def test_invalid_settings_do_not_replace_saved_values(parameters):
    expected = {"peak_boost_enabled": True, "peak_boost_days": 20}
    settings.save_parameters(expected)
    with pytest.raises(ValueError):
        settings.save_parameters(parameters)
    assert settings.read_state() == expected


@pytest.mark.parametrize("contents", ["{invalid", '{"peak_boost_enabled":true,"peak_boost_days":null}'])
def test_corrupt_configuration_reports_error_without_rewriting(contents):
    settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 20})
    path = settings.data_directory() / "parameters.json"
    path.write_text(contents, encoding="utf-8")
    with pytest.raises(ValueError):
        settings.read_state()
    assert path.read_text(encoding="utf-8") == contents
