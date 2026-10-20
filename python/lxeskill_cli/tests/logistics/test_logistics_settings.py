from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import UUID, uuid4

import pytest

from services.agent_cli.logistics import settings
from services.agent_cli.logistics.provider_registry import PROVIDERS


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))
    monkeypatch.setattr(settings, "discover_stores", lambda: [])


def profile(provider="tiantai", name="天泰-新棱镜"):
    return {"display_name": name, "provider_id": provider, "enabled": True,
            "store_binding": None if provider == "jiufang" else {"store_id": "VycOXC1cvUBC/rBIOnYXUg==", "store_name": "店铺 A"},
            "account_name": "深圳市新棱镜贸易有限公司" if provider in ("wesa", "tiantai") else None,
            "login_username": None, "credential_id": None}


def target():
    return settings.data_directory() / "profiles.json"


def test_first_read_persists_and_registry_matches_real_adapter_modules():
    state = settings.settings_state()
    assert state["profiles"] == [] and state["revision"] == 0
    assert json.loads(target().read_text())["schema_version"] == 2
    assert {p.provider_id for p in PROVIDERS} == {"wesa", "feiwo", "yuntuo", "tiantai", "jiufang"}
    import importlib
    for spec in PROVIDERS:
        assert callable(importlib.import_module(f"services.agent_cli.logistics.{spec.provider_id}_query").run)


@pytest.mark.parametrize("provider", ["wesa", "feiwo", "yuntuo", "tiantai", "jiufang"])
def test_each_provider_and_server_owned_fields(provider):
    saved = settings.save_profile(profile(provider), 0)
    item = saved["profiles"][0]
    assert str(UUID(item["profile_id"])) == item["profile_id"]
    assert item["created_at"].endswith("Z") and item["updated_at"].endswith("Z")
    assert settings.read_snapshot() == saved
    if provider != "jiufang":
        assert item["store_binding"]["store_id"].endswith("==")


def test_two_accounts_update_disable_delete_and_revision():
    first = settings.save_profile(profile(), 0)["profiles"][0]
    second = settings.save_profile({**profile(name="天泰-久艺"), "account_name": "深圳市久艺电子商务有限公司"}, 1)
    assert len(second["profiles"]) == 2
    raw = {key: first[key] for key in settings.INPUT_FIELDS | {"profile_id"}}
    updated = settings.save_profile({**raw, "enabled": False}, 2)
    item = next(p for p in updated["profiles"] if p["profile_id"] == first["profile_id"])
    assert not item["enabled"] and item["created_at"] == first["created_at"]
    deleted = settings.delete_profile(first["profile_id"], 3)
    assert deleted["revision"] == 4 and len(deleted["profiles"]) == 1
    with pytest.raises(ValueError, match="does not exist"):
        settings.save_profile(raw, 4)


@pytest.mark.parametrize("change", [
    {"display_name": ""}, {"display_name": "x" * 81}, {"display_name": " padded"},
    {"display_name": "x\ny"}, {"enabled": 1}, {"provider_id": "other"}, {"provider_id": []},
    {"account_name": "x"}, {"account_name": "x" * 201},
    {"store_binding": None}, {"store_binding": {"store_id": "A", "store_name": ""}},
    {"store_binding": {"store_id": "A", "store_name": "A", "browser_id": 1}},
    {"profile_id": "not-uuid"}, {"profile_id": "00000000-0000-0000-0000-000000000001"},
    *[{key: "credential-value"} for key in ("password", "secret", "api_key", "token", "cookie", "sign", "Authorization", "browser_id", "debugging_port", "url", "module")],
    {"created_at": "2026-10-19T00:00:00Z"},
])
def test_invalid_input_never_changes_file(change):
    settings.save_profile(profile(), 0)
    before = target().read_bytes()
    with pytest.raises((ValueError, TypeError)):
        settings.save_profile({**profile(name="other"), **change}, 1)
    assert target().read_bytes() == before


@pytest.mark.parametrize("provider", ["feiwo", "yuntuo", "jiufang"])
def test_unused_account_rejected(provider):
    with pytest.raises(ValueError, match="does not use"):
        settings.save_profile({**profile(provider), "account_name": "公司"}, 0)


def test_public_rejects_store():
    with pytest.raises(ValueError, match="must not have"):
        settings.save_profile({**profile("jiufang"), "store_binding": profile()["store_binding"]}, 0)


@pytest.mark.parametrize("bad", [True, -1, 1.5, "0", 9007199254740991])
def test_invalid_revision(bad):
    with pytest.raises(ValueError, match="revision"):
        settings.save_profile(profile(), bad)


def test_duplicate_names_and_stale_revision_preserve_bytes():
    settings.save_profile(profile(name="Account A"), 0)
    before = target().read_bytes()
    with pytest.raises(ValueError, match="Duplicate"):
        settings.save_profile(profile(name="account a"), 1)
    with pytest.raises(ValueError, match="Revision conflict"):
        settings.save_profile(profile(name="Other"), 0)
    assert target().read_bytes() == before


@pytest.mark.parametrize("bad", [
    "{broken", '{"schema_version":1,"schema_version":1,"revision":0,"profiles":[]}',
    '{"schema_version":3,"revision":0,"profiles":[]}',
    '{"schema_version":true,"revision":0,"profiles":[]}',
    '{"schema_version":1,"revision":0,"profiles":[],"token":"secret"}',
])
def test_corrupt_snapshot_keeps_actual_error_and_original(bad):
    settings.read_snapshot()
    target().write_text(bad)
    with pytest.raises((ValueError, TypeError)):
        settings.read_snapshot()
    with pytest.raises((ValueError, TypeError)):
        settings.save_profile(profile(), 0)
    assert target().read_text() == bad
    if bad == "{broken":
        with pytest.raises(json.JSONDecodeError, match="property name"):
            settings.read_snapshot()


def test_invalid_saved_profile_fields_and_duplicate_ids():
    saved = settings.save_profile(profile(), 0)
    for change in ({"created_at": "invalid"}, {"extra": "secret"}, {"updated_at": "2000-01-01T00:00:00Z"}):
        bad = {**saved, "profiles": [{**saved["profiles"][0], **change}]}
        target().write_text(json.dumps(bad))
        with pytest.raises(ValueError):
            settings.read_snapshot()
    target().write_text(json.dumps({**saved, "profiles": saved["profiles"] * 2}))
    with pytest.raises(ValueError, match="Duplicate"):
        settings.read_snapshot()


def test_failed_replace_preserves_file_and_cleans_temp(monkeypatch):
    settings.read_snapshot()
    before = target().read_bytes()
    def failure(*args):
        raise PermissionError("fixture replace denied")
    monkeypatch.setattr(settings.os, "replace", failure)
    with pytest.raises(PermissionError, match="fixture replace denied"):
        settings.save_profile(profile(), 0)
    assert target().read_bytes() == before
    assert not list(target().parent.glob("*.tmp"))


def test_concurrent_processes_only_one_revision_wins():
    settings.read_snapshot()
    request = json.dumps(profile())
    code = """import json,sys
from services.agent_cli.logistics.settings import save_profile
try:
 save_profile(json.loads(sys.argv[1]), 0)
 print('saved')
except ValueError as exc:
 print(str(exc))
"""
    def child(_):
        result = subprocess.run([sys.executable, "-I", "-B", "-c", code, request], capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stderr
        return result.stdout
    with ThreadPoolExecutor(max_workers=2) as executor:
        outputs = list(executor.map(child, range(2)))
    assert sum("saved" in output for output in outputs) == 1
    assert sum("Revision conflict" in output for output in outputs) == 1
    assert len(settings.read_snapshot()["profiles"]) == 1


def test_store_failure_preserves_profiles_and_redacts_real_error(monkeypatch):
    settings.save_profile(profile(), 0)
    monkeypatch.setenv("ZINIAO_PASSWORD", "password-value")
    def failure():
        raise RuntimeError("fixture getBrowserList failure: password-value " + "x" * 5000)
    monkeypatch.setattr(settings, "discover_stores", failure)
    state = settings.settings_state()
    assert len(state["profiles"]) == 1 and state["stores"] == []
    assert "fixture getBrowserList failure" in state["stores_error"]
    assert "password-value" not in state["stores_error"] and "[truncated]" in state["stores_error"]


@pytest.mark.parametrize("running_entry", [{"browserOauth": "7"}, {"browserOauth": "base64==", "browserId": 8}])
def test_discovery_uses_only_readonly_local_status_apis(monkeypatch, running_entry):
    # Restore real discovery without calling a production endpoint.
    from importlib import reload
    reload(settings)
    from services.browser.store.ziniao_client import ZiniaoClient
    calls = []
    def catalog(self):
        calls.append("catalog")
        return [{"browserOauth": "base64==", "browserName": "运行", "browserId": 7},
                {"browserOauth": "other==", "browserName": "停止", "browserId": 8}]
    def running(self):
        calls.append("running")
        return [running_entry]
    monkeypatch.setattr(ZiniaoClient, "get_browser_list", catalog)
    monkeypatch.setattr(ZiniaoClient, "get_running_info", running)
    assert settings.discover_stores() == [
        {"store_id": "base64==", "store_name": "运行", "running": True},
        {"store_id": "other==", "store_name": "停止", "running": False}]
    assert calls == ["catalog", "running"]


def test_no_database_or_other_settings_created(tmp_path):
    settings.save_profile(profile(), 0)
    settings.settings_state()
    files = sorted(p.name for p in (tmp_path / "app").rglob("*") if p.is_file())
    assert files == [".settings.lock", "profiles.json"]


def test_fsync_precedes_atomic_replacement(monkeypatch):
    settings.read_snapshot()
    events = []
    original_sync, original_replace = settings.os.fsync, settings.os.replace
    def sync(fd):
        events.append("fsync")
        return original_sync(fd)
    def replace(source, destination):
        assert events == ["fsync"]
        assert settings.validate_snapshot(json.loads(Path(source).read_text()))["revision"] == 1
        events.append("replace")
        return original_replace(source, destination)
    monkeypatch.setattr(settings.os, "fsync", sync)
    monkeypatch.setattr(settings.os, "replace", replace)
    settings.save_profile(profile(), 0)
    assert events == ["fsync", "replace"]


def test_timestamp_comparison_handles_optional_fractional_seconds():
    saved = settings.save_profile(profile(), 0)
    item = saved["profiles"][0]
    item["created_at"] = "2026-10-19T00:00:00Z"
    item["updated_at"] = "2026-10-19T00:00:00.123Z"
    assert settings.validate_snapshot(saved) == saved


def test_private_entrypoint_reports_corrupt_json_before_any_store_api():
    settings.read_snapshot()
    target().write_text("{broken")
    child = subprocess.run([sys.executable, "-I", "-B", "-m", "services.agent_cli.logistics.settings", "read"], capture_output=True, text=True, timeout=10)
    assert child.returncode == 1
    message = json.loads(child.stdout)["error"]
    assert "JSONDecodeError" in message and "property name" in message
    assert target().read_text() == "{broken"


def test_write_limit_cannot_create_an_unreadable_snapshot():
    saved = settings.save_profile(profile(), 0)
    before = target().read_bytes()
    # Every individual field is legal, but the total UTF-8 payload is too large.
    profiles = [{**profile(name=f"配置-{index}"), "profile_id": str(uuid4()),
                 "store_binding": {"store_id": "😀" * 512, "store_name": "😀" * 512},
                 "account_name": "😀" * 200, "created_at": "2026-10-19T00:00:00Z", "updated_at": "2026-10-19T00:00:00Z"}
                for index in range(200)]
    with pytest.raises(ValueError, match="1 MiB"):
        settings._write(settings.data_directory(), {**saved, "profiles": profiles})
    assert target().read_bytes() == before


def test_legacy_profiles_migrate_without_inventing_login_or_rewriting_on_read():
    saved = settings.save_profile(profile(), 0)
    legacy = {**saved, "schema_version": 1, "profiles": [
        {key: value for key, value in saved["profiles"][0].items() if key not in {"login_username", "credential_id"}}
    ]}
    target().write_text(json.dumps(legacy))
    before = target().read_bytes()
    migrated = settings.read_snapshot()
    assert target().read_bytes() == before
    assert migrated["schema_version"] == 2 and migrated["revision"] == 1
    item = migrated["profiles"][0]
    assert item["account_name"] == "深圳市新棱镜贸易有限公司"
    assert item["login_username"] is None and item["credential_id"] is None
    result = settings.save_profile({key: item[key] for key in settings.INPUT_FIELDS | {"profile_id"}}, 1)
    assert result["revision"] == 2 and json.loads(target().read_text())["schema_version"] == 2


@pytest.mark.parametrize("provider", ["wesa", "feiwo", "yuntuo", "tiantai"])
def test_login_username_is_independent_of_company_and_password_is_never_accepted(provider):
    reference = str(uuid4())
    saved = settings.save_profile({**profile(provider), "login_username": "actual-login-123", "credential_id": reference}, 0)
    item = saved["profiles"][0]
    assert item["login_username"] == "actual-login-123" and item["credential_id"] == reference
    assert item["account_name"] != item["login_username"]
    assert "password" not in item
    before = target().read_bytes()
    with pytest.raises(ValueError, match="Expected only fields"):
        settings.save_profile({**profile(provider, "other"), "password": "private-password"}, 1)
    assert target().read_bytes() == before


@pytest.mark.parametrize("change", [
    {"login_username": " padded"}, {"login_username": ""}, {"login_username": "x" * 201},
    {"credential_id": "not-a-reference"}, {"credential_id": str(uuid4())},
])
def test_invalid_login_metadata_preserves_existing_profiles(change):
    settings.save_profile(profile(), 0)
    before = target().read_bytes()
    with pytest.raises(ValueError):
        settings.save_profile({**profile(name="Other"), **change}, 1)
    assert target().read_bytes() == before


def test_public_credentials_and_shared_credential_references_are_rejected():
    reference = str(uuid4())
    with pytest.raises(ValueError, match="must not have login"):
        settings.save_profile({**profile("jiufang"), "login_username": "user"}, 0)
    settings.save_profile({**profile(), "login_username": "user", "credential_id": reference}, 0)
    before = target().read_bytes()
    with pytest.raises(ValueError, match="Duplicate credential_id"):
        settings.save_profile({**profile(name="Other"), "login_username": "user", "credential_id": reference}, 1)
    assert target().read_bytes() == before


def test_private_snapshot_does_not_discover_stores(monkeypatch):
    def failure():
        raise AssertionError("snapshot must not discover stores")
    monkeypatch.setattr(settings, "discover_stores", failure)
    assert settings.settings_state(discover=False)["stores_error"] is None


@pytest.mark.parametrize("provider", ["wesa", "tiantai"])
def test_configuration_does_not_require_a_company_name(provider):
    raw = profile(provider)
    raw.pop("account_name")
    saved = settings.save_profile({**raw, "login_username": "actual-login", "credential_id": str(uuid4())}, 0)
    assert saved["profiles"][0]["account_name"] is None
    assert saved["profiles"][0]["login_username"] == "actual-login"
    assert settings.read_snapshot() == saved
