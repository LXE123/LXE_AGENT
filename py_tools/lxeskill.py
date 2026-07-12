from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from py_tools.business import allowed_output_file, execute_module_json, load_catalog
from shared.agent_state import merge_agent_state
from shared.db.sqlite.engine import connection_scope
from shared.infra.net import bootstrap_network_policy
from shared.logging import get_logger, setup_logging
from shared.process_lock import InterProcessLockTimeout, interprocess_lock
from services.browser.store.agent_tool_state import load_tool_state


logger = get_logger(__name__)
PROTOCOL_VERSION = "1"
EXIT_USAGE = 2
EXIT_ENVIRONMENT = 3
EXIT_BUSINESS = 4
EXIT_INTERNAL = 5
PROJECT_ROOT = Path(__file__).resolve().parents[1]


class LxeSkillError(RuntimeError):
    def __init__(self, code: str, message: str, *, exit_code: int = EXIT_INTERNAL) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


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
        payload = json.loads(Path(input_path).expanduser().read_text(encoding="utf-8"))
    elif stdin_json:
        payload = json.loads(sys.stdin.read())
    else:
        payload = _arguments_from_flags(entry, forwarded)
    if not isinstance(payload, dict):
        raise LxeSkillError("invalid_arguments", "command input must be a JSON object", exit_code=EXIT_USAGE)
    return dict(payload), str(session_id or os.environ.get("LXE_AGENT_SESSION_ID") or "").strip()


def _session_lock_path(session_id: str) -> Path:
    digest = sha256(session_id.encode("utf-8")).hexdigest()[:24]
    return PROJECT_ROOT / "tmp" / "lxeskill" / f"session-{digest}.lock"


def _patch_session_state(session_id: str, patch: dict[str, Any]) -> None:
    with connection_scope() as conn:
        row = conn.execute("SELECT source FROM agent_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            raise LxeSkillError("session_not_found", f"agent session not found: {session_id}", exit_code=EXIT_ENVIRONMENT)
        source = json.loads(str(row["source"] or "{}"))
        source["tool_state"] = merge_agent_state(dict(source.get("tool_state") or {}), patch)
        conn.execute(
            "UPDATE agent_sessions SET source = ?, last_active_at = ? WHERE session_id = ?",
            (json.dumps(source, ensure_ascii=False, separators=(",", ":")), time.time(), session_id),
        )


async def _execute_browser(entry: dict[str, Any], arguments: dict[str, Any], session_id: str) -> tuple[dict[str, Any], list[str]]:
    if not session_id:
        raise LxeSkillError("session_required", "browser command requires LXE_AGENT_SESSION_ID", exit_code=EXIT_ENVIRONMENT)
    try:
        with interprocess_lock(_session_lock_path(session_id), timeout_seconds=180):
            state_data = load_tool_state(session_id)
            if state_data is None:
                raise LxeSkillError("session_not_found", f"agent session not found: {session_id}", exit_code=EXIT_ENVIRONMENT)
            from services.browser.tools import client as browser_client

            session = SimpleNamespace(session_id=session_id, source={}, state_data=state_data)
            result = await browser_client.execute_browser_tool(str(entry.get("name") or ""), arguments, session)
            if result.state_patch:
                _patch_session_state(session_id, dict(result.state_patch))
            if not result.success:
                raise LxeSkillError(
                    str(result.error_code or "browser_tool_failed"),
                    str(result.error_message or "browser command failed"),
                    exit_code=EXIT_BUSINESS,
                )
            content = [dict(item or {}) for item in list(result.content or [])]
            data = {"content": content}
            return data, [str(allowed_output_file(str(path))) for path in list(result.files or [])]
    except InterProcessLockTimeout as exc:
        raise LxeSkillError("session_busy", str(exc), exit_code=EXIT_ENVIRONMENT) from exc


def _execute_auth(arguments: dict[str, Any]) -> dict[str, Any]:
    bootstrap_network_policy(label="lxeskill_auth", emit=logger.info)
    from browser_auth_service.service import ensure_auth

    return ensure_auth(
        scope=str(arguments.get("scope") or "erp"),
        account=str(arguments.get("account") or ""),
        require_wms_cookie_header=bool(arguments.get("require_wms_cookie_header")),
        force_refresh=bool(arguments.get("force") or arguments.get("force_refresh")),
    )


def _run_entry(entry: dict[str, Any], argv: list[str]) -> int:
    command = _command_text(entry)
    arguments, session_id = _input_arguments(entry, argv)
    if str(entry.get("session_mode") or "none") == "lxe_session" and not session_id:
        raise LxeSkillError("session_required", f"{command} requires an LXE session", exit_code=EXIT_ENVIRONMENT)
    if str(entry.get("visibility") or "") == "maintenance":
        data = _execute_auth(arguments)
        files: list[str] = []
    elif str(entry.get("handler") or "") == "browser":
        data, files = asyncio.run(_execute_browser(entry, arguments, session_id))
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
            raise LxeSkillError(str((error or {}).get("code") or "business_failed"), str((error or {}).get("message") or "business command failed"), exit_code=EXIT_BUSINESS)
    _emit({"type": "result", "command": command, "ok": True, "data": data, "files": files})
    return 0


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    setup_logging()
    arguments = list(sys.argv[1:] if argv is None else argv)
    catalog = load_catalog()
    try:
        if not arguments or arguments[0] in {"-h", "--help", "help"}:
            _emit(
                {
                    "type": "result",
                    "command": "help",
                    "ok": True,
                    "data": {
                        "usage": "lxeskill <list|describe|command> [options]",
                        "input_modes": ["flags", "--input-json <path>", "--stdin-json"],
                    },
                    "files": [],
                }
            )
            return 0
        if arguments[0] == "list":
            entries = [_public_entry(entry) for entry in catalog.values() if str(entry.get("visibility") or "") != "internal"]
            _emit({"type": "result", "command": "list", "ok": True, "data": {"commands": entries}, "files": []})
            return 0
        if arguments[0] == "describe":
            entry, remaining = _resolve_entry(arguments[1:], catalog)
            if remaining:
                raise LxeSkillError("invalid_arguments", f"unexpected arguments: {' '.join(remaining)}", exit_code=EXIT_USAGE)
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
        _emit({"type": "result", "command": " ".join(arguments), "ok": False, "data": {}, "files": [], "error": {"code": exc.code, "message": str(exc)}})
        return exc.exit_code
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
