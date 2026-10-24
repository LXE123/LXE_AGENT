from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from services.mabang.amazon.fba import replenishment_v2_settings as settings


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))


@pytest.mark.parametrize("days", [None, 0, 20, 120])
def test_custom_days_persist_without_converting_blank_to_zero(days):
    parameters = {"peak_boost_enabled": days is not None, "peak_boost_days": days}
    assert settings.save_parameters(parameters) == parameters
    assert settings.read_state() == parameters


@pytest.mark.parametrize("enabled,days", [(False, None), (True, None), (True, 20)])
def test_legacy_setting_keeps_days_but_requires_a_new_opt_in(enabled, days):
    path = settings.data_directory() / "parameters.json"
    path.parent.mkdir(parents=True)
    original = json.dumps({"peak_boost_enabled": enabled, **({"peak_boost_days": days} if days is not None else {})})
    path.write_text(original, encoding="utf-8")
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": days}
    assert path.read_text(encoding="utf-8") == original


@pytest.mark.parametrize("days", [-1, 121, 1.5, True, "20", "", float("nan"), float("inf")])
def test_invalid_days_are_rejected_including_when_disabled(days):
    with pytest.raises(ValueError, match="peak_boost_days"):
        settings.save_parameters({"peak_boost_enabled": False, "peak_boost_days": days})


def test_default_is_off_and_persists_across_reads():
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": None}
    assert settings.read_state()["peak_boost_enabled"] is False
    assert json.loads((settings.data_directory() / "parameters.json").read_text()) == {"peak_boost_enabled": False, "peak_boost_days": None}


def test_enabled_setting_requires_explicit_days_and_stays_enabled_after_restart():
    with pytest.raises(ValueError, match="加成天数"):
        settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": None})
    parameters = {"peak_boost_enabled": True, "peak_boost_days": 20}
    assert settings.save_parameters(parameters) == parameters
    assert settings.read_state() == parameters
    # The old reader rejects any field beyond these two, including schema_version.
    contents = (settings.data_directory() / "parameters.json").read_bytes()
    assert json.loads(contents) == parameters
    assert b"\r\n" not in contents  # The fingerprint uses the same UTF-8 bytes on Windows.


@pytest.mark.parametrize("enabled,days", [(False, None), (True, 0), (True, 20)])
def test_inline_v2_config_is_converted_to_rollback_readable_format(enabled, days):
    parameters = {"peak_boost_enabled": enabled, "peak_boost_days": days}
    path = settings.data_directory() / "parameters.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"schema_version": 2, **parameters}), encoding="utf-8")
    assert settings.read_state() == parameters
    assert json.loads(path.read_text()) == parameters
    assert settings.read_state() == parameters


@pytest.mark.parametrize("legacy", [
    {"peak_boost_enabled": True},
    {"peak_boost_enabled": True, "peak_boost_days": 40},
])
def test_old_writer_cannot_reuse_stale_v2_opt_in(legacy):
    settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 20})
    path = settings.data_directory() / "parameters.json"
    original = json.dumps(legacy)
    path.write_text(original, encoding="utf-8")
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": legacy.get("peak_boost_days")}
    assert path.read_text() == original
    parameters = {"peak_boost_enabled": True, "peak_boost_days": 15}
    settings.save_parameters(parameters)
    assert settings.read_state() == parameters


def test_old_writer_rewriting_identical_values_cannot_reuse_v2_opt_in():
    settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 20})
    path = settings.data_directory() / "parameters.json"
    original = path.read_bytes()
    previous = path.stat()
    path.write_bytes(original)
    os.utime(path, ns=(previous.st_atime_ns, previous.st_mtime_ns + 1_000_000))
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": 20}
    assert path.read_bytes() == original


def test_interrupted_metadata_save_does_not_enable_boost(monkeypatch):
    settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 20})
    path = settings.data_directory() / "parameters.json"
    path.write_text(json.dumps({"peak_boost_enabled": False, "peak_boost_days": 20}), encoding="utf-8")
    replace = settings.os.replace

    def fail_metadata(source, destination):
        if Path(destination).name == "parameters.meta.json":
            raise OSError("fixture metadata publish failed")
        return replace(source, destination)

    monkeypatch.setattr(settings.os, "replace", fail_metadata)
    with pytest.raises(OSError, match="fixture metadata publish failed"):
        settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 20})
    assert settings.read_state() == {"peak_boost_enabled": False, "peak_boost_days": 20}
    assert not list(settings.data_directory().glob("*.tmp"))


@pytest.mark.parametrize("raw", [
    "{invalid",
    '{"schema_version":1,"parameters_fingerprint":"' + "0" * 64 + '"}',
    '{"schema_version":2,"parameters_fingerprint":null}',
])
def test_corrupt_v2_metadata_fails_without_rewriting_configuration(raw):
    settings.save_parameters({"peak_boost_enabled": True, "peak_boost_days": 20})
    path = settings.data_directory() / "parameters.json"
    original = path.read_bytes()
    metadata = settings.data_directory() / "parameters.meta.json"
    metadata.write_text(raw, encoding="utf-8")
    with pytest.raises(ValueError):
        settings.read_state()
    assert path.read_bytes() == original
    assert metadata.read_text() == raw


def test_saved_setting_is_used_by_next_read():
    assert settings.save_parameters({"peak_boost_enabled": False, "peak_boost_days": 20}) == {"peak_boost_enabled": False, "peak_boost_days": 20}
    assert settings.read_state()["peak_boost_enabled"] is False


@pytest.mark.parametrize("version", [1, True, "2"])
def test_unsupported_config_version_is_rejected_without_rewriting(version):
    path = settings.data_directory() / "parameters.json"
    path.parent.mkdir(parents=True)
    raw = json.dumps({"schema_version": version, "peak_boost_enabled": True, "peak_boost_days": 20})
    path.write_text(raw, encoding="utf-8")
    with pytest.raises(ValueError, match="配置版本"):
        settings.read_state()
    assert path.read_text(encoding="utf-8") == raw


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
