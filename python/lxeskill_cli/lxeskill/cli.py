from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any

from lxeskill.business import ArtifactPathError, execute_module_json, load_catalog
from lxeskill.browser import BrowserCliError, execute_browser_command
from shared.infra.net import bootstrap_network_policy
from shared.input_assets import InputAssetError, current_asset, promote_asset
from shared.logging import get_logger, setup_logging
from shared.repository import skills_root
from shared.workspace import activate_project_workspace, resolve_workspace_input


logger = get_logger(__name__)
PROTOCOL_VERSION = "1"
EXIT_USAGE = 2
EXIT_ENVIRONMENT = 3
EXIT_BUSINESS = 4
EXIT_INTERNAL = 5


class LxeSkillError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        exit_code: int = EXIT_INTERNAL,
        recovery: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code
        self.recovery = dict(recovery or {})


def _configure_stdio() -> None:
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def _emit(payload: dict[str, Any]) -> None:
    record = {"protocol_version": PROTOCOL_VERSION, **payload}
    sys.stdout.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _command_text(entry: dict[str, Any]) -> str:
    return " ".join(str(item) for item in list(entry.get("command_path") or []))


def _public_entry(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "command": _command_text(entry),
        "name": str(entry.get("name") or ""),
        "visibility": str(entry.get("visibility") or "business"),
        "session_mode": str(entry.get("session_mode") or "none"),
        "owner_skills": list(entry.get("owner_skills") or []),
        "attribution_skill": str(entry.get("attribution_skill") or ""),
        "artifact_paths": list(entry.get("artifact_paths") or []),
        "input_schema": dict(entry.get("input_schema") or {}),
        "usage": f"lxeskill {_command_text(entry)} [options]",
    }


def _resolve_entry(argv: list[str], catalog: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    matches: list[tuple[int, dict[str, Any]]] = []
    for entry in catalog.values():
        path = [str(item) for item in list(entry.get("command_path") or [])]
        if path and argv[: len(path)] == path:
            matches.append((len(path), entry))
        aliases = [str(item) for item in list(entry.get("legacy_aliases") or [])]
        if argv and argv[0] in aliases:
            matches.append((1, entry))
    if not matches:
        raise LxeSkillError("unknown_command", f"unknown lxeskill command: {' '.join(argv)}", exit_code=EXIT_USAGE)
    consumed, entry = max(matches, key=lambda item: item[0])
    return entry, argv[consumed:]


def _coerce(value: str, schema: dict[str, Any]) -> Any:
    kind = schema.get("type")
    kinds = list(kind) if isinstance(kind, list) else [kind]
    if "integer" in kinds:
        return int(value)
    if "number" in kinds:
        return float(value)
    if "object" in kinds:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise LxeSkillError("invalid_arguments", f"expected a JSON object, got: {value[:120]}", exit_code=EXIT_USAGE) from exc
        if not isinstance(parsed, dict):
            raise LxeSkillError("invalid_arguments", f"expected a JSON object, got: {value[:120]}", exit_code=EXIT_USAGE)
        return parsed
    return value


def _arguments_from_flags(entry: dict[str, Any], argv: list[str]) -> dict[str, Any]:
    schema = dict(entry.get("input_schema") or {})
    properties = dict(schema.get("properties") or {})
    positional = [str(item) for item in list(entry.get("positional") or [])]
    arguments: dict[str, Any] = {}
    remaining = list(argv)
    for name in positional:
        if not remaining or remaining[0].startswith("--"):
            raise LxeSkillError("invalid_arguments", f"missing positional argument: {name}", exit_code=EXIT_USAGE)
        arguments[name] = _coerce(remaining.pop(0), dict(properties.get(name) or {}))
    index = 0
    while index < len(remaining):
        raw = remaining[index]
        if not raw.startswith("--"):
            raise LxeSkillError("invalid_arguments", f"unexpected argument: {raw}", exit_code=EXIT_USAGE)
        raw_name, separator, inline = raw[2:].partition("=")
        name = raw_name.replace("-", "_")
        property_schema = dict(properties.get(name) or {})
        if name not in properties:
            raise LxeSkillError("invalid_arguments", f"unknown option: --{raw_name}", exit_code=EXIT_USAGE)
        kind = property_schema.get("type")
        if kind == "boolean":
            arguments[name] = True
            index += 1
            continue
        if separator:
            value = inline
        else:
            index += 1
            if index >= len(remaining):
                raise LxeSkillError("invalid_arguments", f"missing value for --{raw_name}", exit_code=EXIT_USAGE)
            value = remaining[index]
        if kind == "array":
            item = _coerce(value, dict(property_schema.get("items") or {}))
            arguments.setdefault(name, []).append(item)
        else:
            arguments[name] = _coerce(value, property_schema)
        index += 1
    return arguments


def _input_arguments(entry: dict[str, Any], argv: list[str]) -> tuple[dict[str, Any], str]:
    session_id = ""
    input_path = ""
    stdin_json = False
    forwarded: list[str] = []
    index = 0
    while index < len(argv):
        value = argv[index]
        if value in {"--input-json", "--session-id"}:
            index += 1
            if index >= len(argv):
                raise LxeSkillError("invalid_arguments", f"missing value for {value}", exit_code=EXIT_USAGE)
            if value == "--input-json":
                input_path = argv[index]
            else:
                session_id = argv[index]
        elif value == "--stdin-json":
            stdin_json = True
        else:
            forwarded.append(value)
        index += 1
    if input_path and stdin_json:
        raise LxeSkillError("invalid_arguments", "choose only one of --input-json or --stdin-json", exit_code=EXIT_USAGE)
    if input_path:
        payload = json.loads(resolve_workspace_input(input_path).read_text(encoding="utf-8"))
    elif stdin_json:
        payload = json.loads(sys.stdin.read())
    else:
        payload = _arguments_from_flags(entry, forwarded)
    if not isinstance(payload, dict):
        raise LxeSkillError("invalid_arguments", "command input must be a JSON object", exit_code=EXIT_USAGE)
    return dict(payload), str(session_id or os.environ.get("LXE_AGENT_SESSION_ID") or "").strip()


def _is_missing(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip()) or (
        isinstance(value, list) and not value
    )


def _asset_slot_fields(entry: dict[str, Any]) -> dict[str, str]:
    """Field -> slot id, for fields backed by a stored long-lived asset."""
    properties = dict(dict(entry.get("input_schema") or {}).get("properties") or {})
    return {
        name: str(dict(schema or {}).get("x-lxe-asset-slot") or "")
        for name, schema in properties.items()
        if str(dict(schema or {}).get("x-lxe-asset-slot") or "")
    }


def _apply_stored_assets(entry: dict[str, Any], arguments: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Fill slot-backed fields from storage, and report where each value came from.

    A caller-supplied path always wins and is promoted after the command
    succeeds; only an omitted field falls back to the stored current version.
    """
    sources: dict[str, dict[str, str]] = {}
    for name, slot_id in _asset_slot_fields(entry).items():
        if not _is_missing(arguments.get(name)):
            sources[name] = {"slot": slot_id, "from": "upload"}
            continue
        stored = current_asset(slot_id)
        if stored is None:
            continue
        arguments[name] = str(stored.path)
        sources[name] = {
            "slot": slot_id,
            "from": "stored",
            "file_name": stored.file_name,
            "updated_at": stored.updated_at,
        }
    return sources


def _promote_supplied_assets(
    entry: dict[str, Any],
    arguments: dict[str, Any],
    sources: dict[str, dict[str, str]],
) -> None:
    """After a successful run, keep the caller-supplied files as the new current."""
    for name, info in sources.items():
        if info.get("from") != "upload":
            continue
        try:
            promoted = promote_asset(info["slot"], str(arguments.get(name) or ""))
        except InputAssetError as exc:
            logger.warning("input_asset_promote_failed: slot=%s error=%s", info["slot"], exc)
            continue
        info["file_name"] = promoted.file_name
        info["updated_at"] = promoted.updated_at


def _require_uploaded_file_inputs(entry: dict[str, Any], arguments: dict[str, Any]) -> None:
    schema = dict(entry.get("input_schema") or {})
    properties = dict(schema.get("properties") or {})
    required = {str(name) for name in list(schema.get("required") or [])}
    slots = _asset_slot_fields(entry)
    # Slot-backed fields are not in `required`, but a command still cannot run
    # when the slot has never been filled — ask for the upload just the same.
    for name in sorted(required | set(slots)):
        property_schema = dict(properties.get(name) or {})
        upload = dict(property_schema.get("x-lxe-file-input") or {})
        if not upload:
            continue
        value = arguments.get(name)
        if not _is_missing(value):
            continue
        accepted_extensions = [
            str(extension).strip()
            for extension in list(upload.get("accepted_extensions") or [])
            if str(extension).strip()
        ]
        instruction = str(upload.get("instruction") or "请上传所需文件，并使用附件保存后的真实绝对路径。")
        raise LxeSkillError(
            "input_required",
            f"Required uploaded file is missing: {name}",
            exit_code=EXIT_USAGE,
            recovery={
                "next_action": "ask_user_to_upload_file",
                "field": name,
                "accepted_extensions": accepted_extensions,
                "instruction": instruction,
            },
        )


def _execute_auth(arguments: dict[str, Any]) -> dict[str, Any]:
    bootstrap_network_policy(label="lxeskill_auth", emit=logger.info)
    from browser_auth_service.service import BrowserAuthRefreshError, refresh_auth

    try:
        return refresh_auth(account=str(arguments.get("account") or ""))
    except BrowserAuthRefreshError as exc:
        payload = exc.to_payload()
        raise RuntimeError(
            "browser_auth_service 刷新失败: "
            f"stage={payload['stage']} current_url={payload['current_url'] or '-'} "
            f"exception_type={payload['exception_type']} error={payload['message']}"
        ) from exc


def _recovery_for_auth_failure(code: str, message: str) -> dict[str, str] | None:
    text = f"{code} {message}".lower()
    if not any(marker in text for marker in ("auth", "cookie", "login", "登录", "401", "403", "认证")):
        return None
    return {"command": "lxeskill auth refresh"}


def _skill_scope() -> set[str] | None:
    """Host-injected visibility scope; None means unrestricted (external hosts)."""
    raw = os.environ.get("LXESKILL_SKILL_SCOPE")
    if raw is None:
        return None
    return {item.strip() for item in raw.split(",") if item.strip()}


def _scope_allows(entry: dict[str, Any], scope: set[str] | None) -> bool:
    if scope is None:
        return True
    if str(entry.get("visibility") or "") in {"maintenance", "internal"}:
        # Infrastructure commands stay reachable regardless of scope: recovery
        # hints tell any business bot to run `lxeskill auth refresh` after an
        # auth failure, and that self-healing path must not depend on which
        # business skills the bot can see.
        return True
    owners = [str(owner).strip() for owner in list(entry.get("owner_skills") or []) if str(owner).strip()]
    if not owners:
        return True
    return any(owner in scope for owner in owners)


def _require_in_scope(entry: dict[str, Any]) -> None:
    if _scope_allows(entry, _skill_scope()):
        return
    raise LxeSkillError(
        "skill_not_in_scope",
        f"{_command_text(entry)} is outside this agent's skill scope",
        exit_code=EXIT_ENVIRONMENT,
    )


def _run_entry(entry: dict[str, Any], argv: list[str]) -> int:
    command = _command_text(entry)
    _require_in_scope(entry)
    arguments, session_id = _input_arguments(entry, argv)
    asset_sources = _apply_stored_assets(entry, arguments)
    _require_uploaded_file_inputs(entry, arguments)
    if str(entry.get("session_mode") or "none") == "lxe_session" and not session_id:
        raise LxeSkillError("session_required", f"{command} requires an LXE session", exit_code=EXIT_ENVIRONMENT)
    if str(entry.get("visibility") or "") == "maintenance":
        try:
            data = _execute_auth(arguments)
        except ValueError as exc:
            raise LxeSkillError("auth_environment_invalid", str(exc), exit_code=EXIT_ENVIRONMENT) from exc
        except RuntimeError as exc:
            raise LxeSkillError("auth_refresh_failed", str(exc), exit_code=EXIT_BUSINESS) from exc
        files: list[str] = []
    elif str(entry.get("handler") or "") == "browser":
        try:
            data, files = asyncio.run(execute_browser_command(entry, arguments, session_id))
        except BrowserCliError as exc:
            exit_code = EXIT_ENVIRONMENT if exc.code in {"session_required", "store_busy"} else EXIT_BUSINESS
            raise LxeSkillError(
                exc.code,
                str(exc),
                exit_code=exit_code,
                recovery=_recovery_for_auth_failure(exc.code, str(exc)),
            ) from exc
    else:
        if session_id:
            os.environ["LXE_AGENT_SESSION_ID"] = session_id
        progress = lambda event: _emit({"type": "progress", "command": command, **{k: v for k, v in event.items() if k != "type"}})
        ok, content, files, error = execute_module_json(
            entry,
            arguments,
            {"session_id": session_id},
            on_event=progress,
            on_text=lambda line: sys.stderr.write(f"{line}\n"),
        )
        raw = str(content[0].get("text") or "{}") if content else "{}"
        data = json.loads(raw)
        if not ok:
            failure: dict[str, Any] = {
                    "type": "result",
                    "command": command,
                    "ok": False,
                    "data": data,
                    "files": [],
                    "error": {
                        "code": str((error or {}).get("code") or "business_failed"),
                        "message": str((error or {}).get("message") or "business command failed"),
                    },
                }
            recovery = _recovery_for_auth_failure(failure["error"]["code"], failure["error"]["message"])
            if recovery:
                failure["recovery"] = recovery
            _emit(failure)
            return EXIT_BUSINESS
    _promote_supplied_assets(entry, arguments, asset_sources)
    if asset_sources and isinstance(data, dict):
        data = {**data, "asset_sources": asset_sources}
    _emit({"type": "result", "command": command, "ok": True, "data": data, "files": files})
    return 0


def _run_doctor(catalog: dict[str, dict[str, Any]]) -> int:
    from lxeskill.contract import validate_skill_command_contract

    report = validate_skill_command_contract(catalog, skills_root=skills_root())
    if report.ok:
        _emit({"type": "result", "command": "doctor", "ok": True, "data": report.stats_payload(), "files": []})
        return 0
    _emit(
        {
            "type": "result",
            "command": "doctor",
            "ok": False,
            "data": {
                **report.stats_payload(),
                "violations": [violation.to_payload() for violation in report.violations],
            },
            "files": [],
            "error": {
                "code": "skill_contract_invalid",
                "message": f"Skill command contract has {len(report.violations)} violation(s)",
            },
        }
    )
    return EXIT_ENVIRONMENT


def main(argv: list[str] | None = None) -> int:
    activate_project_workspace()
    return _main(argv)


def _main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    setup_logging()
    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        catalog = load_catalog()
        if not arguments or arguments[0] in {"-h", "--help", "help"}:
            _emit(
                {
                    "type": "result",
                    "command": "help",
                    "ok": True,
                    "data": {
                        "usage": "lxeskill <list|describe|doctor|command> [options]",
                        "input_modes": ["flags", "--input-json <path>", "--stdin-json"],
                    },
                    "files": [],
                }
            )
            return 0
        if arguments[0] == "doctor":
            if len(arguments) != 1:
                raise LxeSkillError(
                    "invalid_arguments",
                    f"unexpected arguments: {' '.join(arguments[1:])}",
                    exit_code=EXIT_USAGE,
                )
            return _run_doctor(catalog)
        if arguments[0] == "list":
            scope = _skill_scope()
            entries = [
                _public_entry(entry)
                for entry in catalog.values()
                if str(entry.get("visibility") or "") != "internal" and _scope_allows(entry, scope)
            ]
            _emit({"type": "result", "command": "list", "ok": True, "data": {"commands": entries}, "files": []})
            return 0
        if arguments[0] == "describe":
            entry, remaining = _resolve_entry(arguments[1:], catalog)
            if remaining:
                raise LxeSkillError("invalid_arguments", f"unexpected arguments: {' '.join(remaining)}", exit_code=EXIT_USAGE)
            _require_in_scope(entry)
            _emit({"type": "result", "command": "describe", "ok": True, "data": _public_entry(entry), "files": []})
            return 0
        if arguments[-1] in {"-h", "--help"}:
            entry, remaining = _resolve_entry(arguments[:-1], catalog)
            if remaining:
                raise LxeSkillError("invalid_arguments", f"unexpected arguments: {' '.join(remaining)}", exit_code=EXIT_USAGE)
            _emit({"type": "result", "command": f"{_command_text(entry)} help", "ok": True, "data": _public_entry(entry), "files": []})
            return 0
        entry, remaining = _resolve_entry(arguments, catalog)
        return _run_entry(entry, remaining)
    except LxeSkillError as exc:
        failure: dict[str, Any] = {
            "type": "result",
            "command": " ".join(arguments),
            "ok": False,
            "data": {},
            "files": [],
            "error": {"code": exc.code, "message": str(exc)},
        }
        if exc.recovery:
            failure["recovery"] = exc.recovery
        _emit(failure)
        return exc.exit_code
    except ArtifactPathError as exc:
        _emit({"type": "result", "command": " ".join(arguments), "ok": False, "data": {}, "files": [], "error": {"code": "invalid_artifact_path", "message": str(exc)}})
        return EXIT_BUSINESS
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        _emit({"type": "result", "command": " ".join(arguments), "ok": False, "data": {}, "files": [], "error": {"code": "invalid_arguments", "message": str(exc)}})
        return EXIT_USAGE
    except KeyboardInterrupt:
        _emit({"type": "result", "command": " ".join(arguments), "ok": False, "data": {}, "files": [], "error": {"code": "cancelled", "message": "command cancelled"}})
        return 130
    except Exception as exc:
        logger.exception("lxeskill command failed")
        _emit({"type": "result", "command": " ".join(arguments), "ok": False, "data": {}, "files": [], "error": {"code": type(exc).__name__, "message": str(exc)}})
        return EXIT_INTERNAL


if __name__ == "__main__":
    raise SystemExit(main())
