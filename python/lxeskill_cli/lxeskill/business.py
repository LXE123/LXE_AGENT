from __future__ import annotations

import contextlib
import importlib
import json
import os
from pathlib import Path
import re
from typing import Any, Callable

from shared.logging import get_logger
from shared.workspace import artifact_root, project_root, resolve_workspace_input


logger = get_logger(__name__)
_ARTIFACT_ROLES = {"deliverable", "model_input", "diagnostic"}
_SELECTOR_PART = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?$")


class ArtifactPathError(ValueError):
    pass


def load_catalog() -> dict[str, dict[str, Any]]:
    path = Path(__file__).with_name("catalog.json")
    document = json.loads(path.read_text(encoding="utf-8"))
    if str(document.get("protocol_version") or "") != "1":
        raise RuntimeError("invalid script tool catalog protocol")
    entries: dict[str, dict[str, Any]] = {}
    modules: set[str] = set()
    command_paths: set[tuple[str, ...]] = set()
    legacy_aliases: set[str] = set()
    allowed_visibilities = {"business", "browser", "maintenance", "internal"}
    allowed_session_modes = {"none", "lxe_session"}
    for raw in list(document.get("entries") or []):
        entry = dict(raw or {})
        name = str(entry.get("name") or "").strip()
        module = str(entry.get("module") or "").strip()
        handler = str(entry.get("handler") or "").strip()
        if not name or name in entries:
            raise RuntimeError(f"duplicate or empty script tool name: {name}")
        if not module and not handler:
            raise RuntimeError(f"script tool has no handler: {name}")
        command_path = tuple(str(item).strip() for item in list(entry.get("command_path") or []))
        if not command_path or any(not item for item in command_path):
            raise RuntimeError(f"lxeskill command path is empty: {name}")
        if command_path in command_paths:
            raise RuntimeError(f"duplicate lxeskill command path: {' '.join(command_path)}")
        command_paths.add(command_path)
        visibility = str(entry.get("visibility") or "").strip()
        if visibility not in allowed_visibilities:
            raise RuntimeError(f"invalid lxeskill visibility for {name}: {visibility}")
        session_mode = str(entry.get("session_mode") or "").strip()
        if session_mode not in allowed_session_modes:
            raise RuntimeError(f"invalid lxeskill session mode for {name}: {session_mode}")
        for declaration in list(entry.get("artifact_paths") or []):
            item = dict(declaration or {})
            selector = str(item.get("field") or "").strip()
            role = str(item.get("role") or "").strip()
            if not selector or any(not _SELECTOR_PART.fullmatch(part) for part in selector.split(".")):
                raise RuntimeError(f"invalid artifact path selector for {name}: {selector}")
            if role not in _ARTIFACT_ROLES:
                raise RuntimeError(f"invalid artifact path role for {name}: {role}")
        for alias_value in list(entry.get("legacy_aliases") or []):
            alias = str(alias_value).strip()
            if not alias or alias in legacy_aliases or alias in entries:
                raise RuntimeError(f"duplicate or empty lxeskill legacy alias: {alias}")
            legacy_aliases.add(alias)
        if module:
            if module in modules:
                raise RuntimeError(f"duplicate script tool module: {module}")
            modules.add(module)
            expected = (
                f"mabang_{module.rsplit('.', 1)[-1]}"
                if module.startswith("services.agent_cli.mabang.")
                else f"amazon_fba_{module.rsplit('.', 1)[-1]}"
                if module.startswith("services.agent_cli.browser.amazon_fba.")
                else ""
            )
            if expected != name:
                raise RuntimeError(f"script tool naming mismatch: {module} -> {name}")
        entries[name] = entry
    return entries


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def allowed_output_file(raw_path: str, *, owner_skills: list[str] | tuple[str, ...] = ()) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = resolve_workspace_input(path)
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError as exc:
        raise ArtifactPathError(f"business CLI returned a missing file: {raw_path}") from exc
    if not resolved.is_file():
        raise ArtifactPathError(f"business CLI returned a path that is not a regular file: {raw_path}")
    roots = [artifact_root().resolve()]
    roots.extend((project_root() / "skills" / skill / "assets").resolve() for skill in owner_skills)
    if not any(_is_within(resolved, root) for root in roots):
        raise ArtifactPathError(f"business CLI returned a file outside allowed artifact roots: {raw_path}")
    return resolved


def _select_artifact_values(payload: Any, selector: str) -> list[Any]:
    values = [payload]
    for raw_part in selector.split("."):
        is_array = raw_part.endswith("[]")
        key = raw_part[:-2] if is_array else raw_part
        selected: list[Any] = []
        for value in values:
            if not isinstance(value, dict) or key not in value:
                continue
            child = value[key]
            if is_array:
                if child is None:
                    continue
                if not isinstance(child, list):
                    raise ArtifactPathError(f"declared artifact field is not an array: {selector}")
                selected.extend(child)
            else:
                selected.append(child)
        values = selected
    return values


def collect_declared_artifacts(entry: dict[str, Any], payload: dict[str, Any]) -> list[str]:
    owners = tuple(str(item) for item in list(entry.get("owner_skills") or []) if str(item).strip())
    deliverables: list[str] = []
    validated: dict[str, str] = {}
    delivered: set[str] = set()
    for declaration in list(entry.get("artifact_paths") or []):
        item = dict(declaration or {})
        selector = str(item.get("field") or "").strip()
        role = str(item.get("role") or "").strip()
        for raw_value in _select_artifact_values(payload, selector):
            if raw_value in (None, ""):
                continue
            if not isinstance(raw_value, (str, os.PathLike)):
                raise ArtifactPathError(f"declared artifact path is not a string: {selector}")
            raw_text = str(raw_value)
            provisional_key = os.path.normcase(str(Path(raw_text).expanduser()))
            resolved = validated.get(provisional_key)
            if resolved is None:
                resolved = str(allowed_output_file(raw_text, owner_skills=owners))
                validated[provisional_key] = resolved
            key = os.path.normcase(resolved)
            if role == "deliverable" and key not in delivered:
                delivered.add(key)
                deliverables.append(resolved)
    return deliverables


def _close_network_clients_best_effort() -> None:
    import asyncio

    from shared.infra.net import close_all_network_clients

    with contextlib.suppress(Exception):
        asyncio.run(close_all_network_clients())


def execute_module_json(
    entry: dict[str, Any],
    arguments: dict[str, Any],
    _session: dict[str, Any],
    *,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    on_text: Callable[[str], None] | None = None,
) -> tuple[bool, list[dict[str, Any]], list[str], dict[str, str] | None]:
    module_name = str(entry.get("module") or "").strip()
    module = importlib.import_module(module_name)
    # The one business contract: run(arguments) -> payload dict, with the
    # catalog input_schema as the argument source. No argv round-trips and
    # no stdout capture.
    run = getattr(module, "run", None)
    if not callable(run):
        raise RuntimeError(f"business module has no callable run(): {module_name}")
    try:
        payload = run(dict(arguments or {}))
    except Exception as exc:  # noqa: BLE001 — business failures become envelopes
        payload = {"success": False, "exception": f"{type(exc).__name__}: {exc}"}
    finally:
        _close_network_clients_best_effort()
    if not isinstance(payload, dict):
        raise RuntimeError(f"business run() must return an object: {module_name}")
    return _finalize_payload(entry, module_name, payload)


def _finalize_payload(
    entry: dict[str, Any],
    module_name: str,
    payload: dict[str, Any],
) -> tuple[bool, list[dict[str, Any]], list[str], dict[str, str] | None]:
    if "success" in payload:
        success = bool(payload.get("success"))
    elif "ok" in payload:
        success = bool(payload.get("ok"))
    else:
        success = True
    if "finished" in payload:
        success = success and bool(payload.get("finished"))
    files = collect_declared_artifacts(entry, payload) if success else []
    content = [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}]
    if success:
        return True, content, files, None
    message = str(payload.get("exception") or payload.get("message") or payload.get("notice") or f"{module_name} failed").strip()
    return False, content, [], {"code": "business_cli_failed", "message": message}


__all__ = [
    "ArtifactPathError",
    "allowed_output_file",
    "collect_declared_artifacts",
    "execute_module_json",
    "load_catalog",
]
