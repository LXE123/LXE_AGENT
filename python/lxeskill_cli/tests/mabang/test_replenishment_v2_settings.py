"""Persistent settings: defaults, legacy opt-in and the real failed-save regression."""
from __future__ import annotations

import json
from pathlib import Path
import pytest
from services.mabang.amazon.fba import replenishment_v2_settings as settings


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))


def test_first_use_is_off_without_default_days():
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": None}


@pytest.mark.parametrize("enabled,days", [(False, None), (True, 0), (True, 20)])
def test_save_reload_retains_old_reader_compatible_fields(enabled, days):
    expected = {"peak_boost_enabled": enabled, "peak_boost_days": days}
    assert settings.save_parameters(expected) == settings.read_state() == expected
    assert json.loads((settings.data_directory() / "parameters.json").read_bytes()) == expected


@pytest.mark.parametrize("inline_version,enabled", [(None, False), (2, True)])
def test_legacy_configuration_requires_opt_in_but_explicit_v2_migrates(inline_version, enabled):
    path = settings.data_directory() / "parameters.json"
    path.parent.mkdir(parents=True)
    raw = {"peak_boost_enabled": True, "peak_boost_days": 20}
    if inline_version:
        raw["schema_version"] = inline_version
    original = json.dumps(raw)
    path.write_text(original)
    assert settings.read_state() == {"peak_boost_enabled": enabled, "peak_boost_days": 20}
    if inline_version:
        assert "schema_version" not in json.loads(path.read_bytes())
    else:
        assert path.read_text() == original


def test_old_writer_invalidates_saved_opt_in():
    settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 20})
    path = settings.data_directory() / "parameters.json"
    path.write_text('{"peak_boost_enabled":true,"peak_boost_days":40}')
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": 40}


@pytest.mark.parametrize("parameters", [
    {"peak_boost_enabled": True, "peak_boost_days": None},
    {"peak_boost_enabled": False, "peak_boost_days": 121},
])
def test_invalid_settings_never_persist(parameters):
    with pytest.raises(ValueError):
        settings.save_parameters(parameters)
    assert not (settings.data_directory() / "parameters.json").exists()


@pytest.mark.parametrize("name", ["parameters.json", "parameters.meta.json"])
def test_corrupt_configuration_reports_error_without_rewriting(name):
    settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 20})
    path = settings.data_directory() / name
    path.write_text("{invalid")
    with pytest.raises(ValueError):
        settings.read_state()
    assert path.read_text() == "{invalid"


@pytest.mark.parametrize("phase", ["parameters.json", "parameters.meta.json", "after-metadata"])
def test_save_failure_restores_previous_effective_values(monkeypatch, phase):
    expected = {"peak_boost_enabled": True, "peak_boost_days": 20}
    settings.save_parameters(expected)
    root = settings.data_directory()
    before = {name: ((root / name).read_bytes(), (root / name).stat().st_mtime_ns)
              for name in ("parameters.json", "parameters.meta.json")}
    replace = settings._replace_text
    def fail(path, text):
        if path.name == phase:
            raise OSError("fixture publish failed")
        replace(path, text)
        if path.name == "parameters.meta.json" and phase == "after-metadata":
            raise OSError("fixture publish failed")
    monkeypatch.setattr(settings, "_replace_text", fail)
    with pytest.raises(OSError, match="fixture publish failed"):
        settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 40})
    assert settings.read_state() == expected
    assert {name: ((root / name).read_bytes(), (root / name).stat().st_mtime_ns) for name in before} == before
    assert not list(root.glob(".settings-rollback-*"))


def test_failed_recovery_keeps_original_backup_and_both_real_errors(monkeypatch):
    original = {"peak_boost_enabled": True, "peak_boost_days": 20}
    settings.save_parameters(original)
    replace = settings.os.replace
    def fail(source, destination):
        if Path(source).parent.name.startswith(".settings-rollback-"):
            raise OSError("fixture rollback failed")
        if Path(destination).name == "parameters.meta.json":
            raise OSError("fixture publish failed")
        return replace(source, destination)
    monkeypatch.setattr(settings.os, "replace", fail)
    with pytest.raises(OSError) as error:
        settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 40})
    assert "fixture publish failed" in str(error.value) and "fixture rollback failed" in str(error.value)
    (backup,) = settings.data_directory().glob(".settings-rollback-*")
    assert str(backup) in str(error.value)
    assert json.loads((backup / "parameters.json").read_bytes()) == original
