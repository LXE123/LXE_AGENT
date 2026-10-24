from __future__ import annotations

import json

import pytest

from services.mabang.amazon.fba import final_restock_settings as settings


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))


@pytest.mark.parametrize("days", [None, 0, 20, 120])
def test_custom_days_persist_without_converting_blank_to_zero(days):
    parameters = {"peak_boost_enabled": True, "peak_boost_days": days}
    assert settings.save_parameters(parameters) == parameters
    assert settings.read_state() == parameters


def test_legacy_setting_keeps_switch_and_uses_default_days():
    path = settings.data_directory() / "parameters.json"
    path.parent.mkdir(parents=True)
    original = '{"peak_boost_enabled":false}'
    path.write_text(original, encoding="utf-8")
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": None}
    assert path.read_text(encoding="utf-8") == original


@pytest.mark.parametrize("days", [-1, 121, 1.5, True, "20", "", float("nan"), float("inf")])
def test_invalid_days_are_rejected_including_when_disabled(days):
    with pytest.raises(ValueError, match="peak_boost_days"):
        settings.save_parameters({"peak_boost_enabled": False, "peak_boost_days": days})


def test_default_is_off_and_persists_across_reads():
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": None}
    assert settings.read_state()["peak_boost_enabled"] is False
    assert json.loads((settings.data_directory() / "parameters.json").read_text()) == {"peak_boost_enabled": False, "peak_boost_days": None}


def test_saved_setting_is_used_by_next_read():
    assert settings.save_parameters({"peak_boost_enabled": False, "peak_boost_days": 20}) == {"peak_boost_enabled": False, "peak_boost_days": 20}
    assert settings.read_state()["peak_boost_enabled"] is False


@pytest.mark.parametrize("raw", [None, {}, {"peak_boost_enabled": 1}, {"peak_boost_enabled": "false"}, {"peak_boost_enabled": True, "extra": False}])
def test_invalid_setting_is_rejected(raw):
    with pytest.raises(ValueError):
        settings.save_parameters(raw)


def test_corrupt_saved_setting_fails_instead_of_silently_defaulting():
    settings.read_state()
    path = settings.data_directory() / "parameters.json"
    path.write_text('{"peak_boost_enabled": "false"}', encoding="utf-8")
    with pytest.raises(ValueError, match="格式无效"):
        settings.read_state()


@pytest.mark.parametrize("days", [-1, 121, 1.5, True, "20", ""])
def test_corrupt_custom_days_fail_on_read_without_overwriting_file(days):
    settings.read_state()
    path = settings.data_directory() / "parameters.json"
    raw = json.dumps({"peak_boost_enabled": True, "peak_boost_days": days})
    path.write_text(raw, encoding="utf-8")
    with pytest.raises(ValueError, match="peak_boost_days"):
        settings.read_state()
    assert path.read_text(encoding="utf-8") == raw
