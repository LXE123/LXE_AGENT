"""Application business inputs. Private Desktop entrypoint, never an agent session."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
from uuid import UUID, uuid4

from shared.process_lock import interprocess_lock
from shared.repository import state_root
from services.yacang.errors import safe_remote_detail
from .provider_registry import PROVIDERS, PROVIDER_BY_ID

MAX_REVISION = 9007199254740990
MAX_PROFILES = 200
BASE_INPUT_FIELDS = {"display_name", "provider_id", "enabled", "account_name"}
INPUT_FIELDS = BASE_INPUT_FIELDS | {"login_username", "credential_id"}
PROFILE_FIELDS = INPUT_FIELDS | {"profile_id", "created_at", "updated_at"}


def diagnostic(exc: Exception) -> str:
    secrets = tuple(value for key, value in os.environ.items()
                    if re.search(r"PASSWORD|SECRET|TOKEN|COOKIE|API_KEY|AUTHORIZATION", key, re.I))
    return safe_remote_detail(f"{type(exc).__name__}: {exc}", secrets=secrets, limit=4000)


def data_directory() -> Path:
    return state_root() / "skill-data" / "logistics-query"


def fields(raw: object, required: set[str], optional: set[str] | None = None) -> dict:
    if not isinstance(raw, dict) or not required <= raw.keys() or raw.keys() - required - (optional or set()):
        # Do not reflect values or unknown keys (which may themselves contain credentials).
        raise ValueError(f"Expected only fields: {', '.join(sorted(required | (optional or set())))}")
    return raw


def text(value: object, label: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum or value != value.strip() or any(ord(c) < 32 for c in value):
        raise ValueError(f"{label}: expected {minimum}–{maximum} characters without surrounding whitespace or control characters")
    return value


def profile_id(value: object) -> str:
    value = text(value, "profile_id", 36, 36)
    if str(UUID(value)) != value:
        raise ValueError("profile_id must be a canonical UUID")
    return value


def revision(value: object) -> int:
    if type(value) is not int or not 0 <= value <= MAX_REVISION:
        raise ValueError("revision must be a non-negative safe integer")
    return value


def validate_input(raw: object) -> dict:
    raw = fields(raw, BASE_INPUT_FIELDS - {"account_name"}, {"account_name", "profile_id", "login_username", "credential_id"})
    result = {"display_name": text(raw["display_name"], "display_name", 1, 80)}
    provider = raw["provider_id"]
    if not isinstance(provider, str) or provider not in PROVIDER_BY_ID:
        raise ValueError("Unknown logistics provider")
    spec = PROVIDER_BY_ID[provider]
    if type(raw["enabled"]) is not bool:
        raise ValueError("enabled must be boolean")
    # Read old company metadata for compatibility; login is configured separately.
    account = raw.get("account_name")
    if spec.requires_account_name and account is not None:
        account = text(account, "account_name", 2, 200)
    elif not spec.requires_account_name and account is not None:
        raise ValueError("This provider does not use account_name")
    result.update(provider_id=provider, enabled=raw["enabled"], account_name=account)
    username, credential = raw.get("login_username"), raw.get("credential_id")
    if spec.transport == "public_http" and (username is not None or credential is not None):
        raise ValueError("Public HTTP providers must not have login credentials")
    if username is not None:
        username = text(username, "login_username", 1, 200)
    if credential is not None:
        credential = profile_id(credential)
        if username is None:
            raise ValueError("credential_id requires login_username")
    result.update(login_username=username, credential_id=credential)
    if "profile_id" in raw:
        result["profile_id"] = profile_id(raw["profile_id"])
    return result


def timestamp(value: object) -> str:
    value = text(value, "timestamp", 20, 40)
    if not value.endswith("Z") or datetime.fromisoformat(value[:-1] + "+00:00").utcoffset().total_seconds() != 0:
        raise ValueError("timestamp must be UTC ISO 8601")
    return value


def validate_snapshot(raw: object) -> dict:
    raw = fields(raw, {"schema_version", "revision", "profiles"})
    if type(raw["schema_version"]) is not int or raw["schema_version"] not in (1, 2, 3):
        raise ValueError("Unsupported logistics settings schema_version")
    revision(raw["revision"])
    profiles = raw["profiles"]
    if not isinstance(profiles, list) or len(profiles) > MAX_PROFILES:
        raise ValueError(f"profiles must be a list of at most {MAX_PROFILES} entries")
    ids, names, credentials = set(), set(), set()
    normalized = []
    for item in profiles:
        version = raw["schema_version"]
        expected_fields = PROFILE_FIELDS if version != 1 else BASE_INPUT_FIELDS | {"profile_id", "created_at", "updated_at"}
        if version < 3:
            expected_fields = expected_fields | {"store_binding"}
        fields(item, expected_fields)
        clean = validate_input({key: item[key] for key in expected_fields - {"created_at", "updated_at", "store_binding"}})
        if version < 3:
            # Validate the complete old schema before dropping the obsolete
            # binding. Reading never rewrites the file or credential reference.
            binding = item["store_binding"]
            if PROVIDER_BY_ID[clean["provider_id"]].requires_store:
                binding = fields(binding, {"store_id", "store_name"})
                for key in ("store_id", "store_name"):
                    text(binding[key], key, 1, 512)
            elif binding is not None:
                raise ValueError("Public HTTP providers must not have a store binding")
        timestamp(item["created_at"])
        timestamp(item["updated_at"])
        if datetime.fromisoformat(item["updated_at"].replace("Z", "+00:00")) < datetime.fromisoformat(item["created_at"].replace("Z", "+00:00")):
            raise ValueError("updated_at precedes created_at")
        identifier, name = item["profile_id"], item["display_name"].casefold()
        if identifier in ids or name in names:
            raise ValueError("Duplicate profile_id or display_name")
        ids.add(identifier)
        names.add(name)
        credential = clean["credential_id"]
        if credential is not None:
            if credential in credentials:
                raise ValueError("Duplicate credential_id")
            credentials.add(credential)
        normalized.append({**clean, "created_at": item["created_at"], "updated_at": item["updated_at"]})
    return {**raw, "schema_version": 3, "profiles": normalized}


def _write(root: Path, snapshot: dict) -> None:
    snapshot = validate_snapshot(snapshot)
    serialized = json.dumps(snapshot, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if len(serialized.encode("utf-8")) > 1024 * 1024:
        raise ValueError("Logistics settings exceed 1 MiB")
    temporary = root / f".profiles-{uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / "profiles.json")
    finally:
        temporary.unlink(missing_ok=True)


def _read(root: Path) -> dict:
    path = root / "profiles.json"
    if not path.exists():
        snapshot = {"schema_version": 3, "revision": 0, "profiles": []}
        _write(root, snapshot)
        return snapshot
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("Logistics settings exceed 1 MiB")
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON field")
            result[key] = value
        return result
    return validate_snapshot(json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_keys))


@contextmanager
def _locked():
    root = data_directory()
    root.mkdir(parents=True, exist_ok=True)
    with interprocess_lock(root / ".settings.lock", timeout_seconds=5):
        yield root


def read_snapshot() -> dict:
    with _locked() as root:
        return _read(root)


def save_profile(raw: object, expected_revision: object) -> dict:
    item = validate_input(raw)
    return _mutate(item, None, revision(expected_revision))


def delete_profile(identifier: object, expected_revision: object) -> dict:
    return _mutate(None, profile_id(identifier), revision(expected_revision))


def _mutate(item: dict | None, delete_id: str | None, expected_revision: int) -> dict:
    with _locked() as root:
        snapshot = _read(root)
        if snapshot["revision"] != expected_revision:
            raise ValueError("Revision conflict: reload logistics settings before saving")
        identifier = delete_id or (item or {}).get("profile_id")
        existing = next((p for p in snapshot["profiles"] if p["profile_id"] == identifier), None)
        if identifier is not None and existing is None:
            raise ValueError("Logistics profile does not exist; reload settings")
        profiles = [p for p in snapshot["profiles"] if p["profile_id"] != identifier]
        if item is not None:
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            profiles.append({**item, "profile_id": identifier or str(uuid4()),
                             "created_at": existing["created_at"] if existing else now, "updated_at": now})
        result = {"schema_version": 3, "revision": snapshot["revision"] + 1, "profiles": profiles}
        _write(root, result)
        return result


def settings_state(snapshot: dict | None = None) -> dict:
    snapshot = read_snapshot() if snapshot is None else snapshot
    providers = [{key: value for key, value in asdict(spec).items() if key != "command"} for spec in PROVIDERS]
    return {**snapshot, "providers": providers}


def run(arguments: dict) -> dict:
    try:
        fields(arguments, {"action"}, {"request"})
        action = arguments["action"]
        request = arguments.get("request")
        if action in ("read", "snapshot") and request is None:
            result = settings_state()
        elif action == "save":
            fields(request, {"input", "expected_revision"})
            result = settings_state(save_profile(request["input"], request["expected_revision"]))
        elif action == "delete":
            fields(request, {"profile_id", "expected_revision"})
            result = settings_state(delete_profile(request["profile_id"], request["expected_revision"]))
        else:
            raise ValueError("Invalid logistics settings operation")
        return {"success": True, "data": result}
    except Exception as exc:
        return {"success": False, "error": diagnostic(exc)}


def main() -> int:
    try:
        action, *args = sys.argv[1:]
        if action in ("read", "snapshot") and not args:
            result = settings_state()
        elif action in ("save", "delete") and len(args) == 1:
            request = json.loads(args[0])
            if action == "save":
                fields(request, {"input", "expected_revision"})
                snapshot = save_profile(request["input"], request["expected_revision"])
            else:
                fields(request, {"profile_id", "expected_revision"})
                snapshot = delete_profile(request["profile_id"], request["expected_revision"])
            result = settings_state(snapshot)
        else:
            raise ValueError("Invalid logistics settings operation")
        print(json.dumps({"success": True, "data": result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"success": False, "error": diagnostic(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
