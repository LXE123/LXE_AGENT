from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CONNECTOR_STATE_PATH_ENV = "LXE_CONNECTOR_STATE_PATH"
CONNECTOR_STATE_VERSION = 1


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


DEFAULT_CONNECTOR_STATE_PATH = _repo_root() / "config" / "connector-states.local.json"


LARK_CLI_SKILL_NAMES = (
    "lark-approval",
    "lark-apps",
    "lark-attendance",
    "lark-base",
    "lark-calendar",
    "lark-contact",
    "lark-doc",
    "lark-drive",
    "lark-event",
    "lark-im",
    "lark-mail",
    "lark-markdown",
    "lark-minutes",
    "lark-note",
    "lark-okr",
    "lark-openapi-explorer",
    "lark-shared",
    "lark-sheets",
    "lark-skill-maker",
    "lark-slides",
    "lark-task",
    "lark-vc",
    "lark-vc-agent",
    "lark-whiteboard",
    "lark-wiki",
    "lark-workflow-meeting-summary",
    "lark-workflow-standup-report",
)


@dataclass(frozen=True)
class ConnectorDefinition:
    id: str
    name: str
    description: str
    kind: str
    skill_names: tuple[str, ...]


CONNECTOR_DEFINITIONS: dict[str, ConnectorDefinition] = {
    "feishu": ConnectorDefinition(
        id="feishu",
        name="Feishu / Lark CLI",
        description=(
            "Controls the official lark-cli skill pack. Disabling hides lark-* "
            "CLI skills from agents, but keeps feishu-im-read available."
        ),
        kind="cli",
        skill_names=LARK_CLI_SKILL_NAMES,
    ),
    "dingtalk": ConnectorDefinition(
        id="dingtalk",
        name="DingTalk Workspace CLI",
        description=(
            "Controls the official dws skill. Disabling hides DingTalk CLI "
            "workspace operations from agents."
        ),
        kind="cli",
        skill_names=("dws",),
    ),
}


def connector_state_path(path: str | Path | None = None) -> Path:
    if path is not None:
        return Path(path).expanduser()
    configured = str(os.getenv(CONNECTOR_STATE_PATH_ENV, "") or "").strip()
    if configured:
        return Path(configured).expanduser()
    return DEFAULT_CONNECTOR_STATE_PATH


def connector_definitions() -> tuple[ConnectorDefinition, ...]:
    return tuple(CONNECTOR_DEFINITIONS.values())


def connector_definition(connector_id: str) -> ConnectorDefinition:
    connector = CONNECTOR_DEFINITIONS.get(str(connector_id or "").strip())
    if connector is None:
        raise KeyError(connector_id)
    return connector


def connector_skill_names(connector_id: str) -> tuple[str, ...]:
    return connector_definition(connector_id).skill_names


def _all_connector_ids() -> set[str]:
    return set(CONNECTOR_DEFINITIONS)


def _normalize_id_list(value: Any, *, default: set[str] | None = None) -> set[str]:
    if value is None:
        return set(default or set())
    if not isinstance(value, list):
        return set(default or set())
    known_ids = _all_connector_ids()
    return {str(item or "").strip() for item in value if str(item or "").strip() in known_ids}


def _default_state() -> dict[str, Any]:
    ids = sorted(_all_connector_ids())
    return {
        "version": CONNECTOR_STATE_VERSION,
        "enabled": ids,
        "everConnected": ids,
        "userDisabled": [],
    }


def _normalize_state(raw_state: Any) -> dict[str, Any]:
    if not isinstance(raw_state, dict):
        raw_state = {}
    default_state = _default_state()
    enabled = _normalize_id_list(raw_state.get("enabled"), default=set(default_state["enabled"]))
    ever_connected = _normalize_id_list(
        raw_state.get("everConnected"),
        default=set(default_state["everConnected"]),
    )
    user_disabled = _normalize_id_list(raw_state.get("userDisabled"), default=set())
    return {
        "version": CONNECTOR_STATE_VERSION,
        "enabled": sorted(enabled),
        "everConnected": sorted(ever_connected),
        "userDisabled": sorted(user_disabled),
    }


def load_connector_state(path: str | Path | None = None) -> dict[str, Any]:
    state_path = connector_state_path(path)
    try:
        raw_state = json.loads(state_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return _default_state()
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"connector state file is not valid JSON: {state_path}") from exc
    return _normalize_state(raw_state)


def write_connector_state(state: dict[str, Any], path: str | Path | None = None) -> dict[str, Any]:
    normalized = _normalize_state(state)
    state_path = connector_state_path(path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = state_path.with_suffix(f"{state_path.suffix}.tmp")
    tmp_path.write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(state_path)
    return normalized


def is_connector_enabled(connector_id: str, path: str | Path | None = None) -> bool:
    connector_definition(connector_id)
    state = load_connector_state(path)
    return str(connector_id or "").strip() in set(state["enabled"])


def set_connector_enabled(
    connector_id: str,
    enabled: bool,
    path: str | Path | None = None,
) -> dict[str, Any]:
    connector = connector_definition(connector_id)
    state = load_connector_state(path)
    enabled_ids = set(state["enabled"])
    ever_connected = set(state["everConnected"])
    user_disabled = set(state["userDisabled"])

    if enabled:
        enabled_ids.add(connector.id)
        ever_connected.add(connector.id)
        user_disabled.discard(connector.id)
    else:
        enabled_ids.discard(connector.id)
        user_disabled.add(connector.id)

    updated_state = write_connector_state(
        {
            "version": CONNECTOR_STATE_VERSION,
            "enabled": sorted(enabled_ids),
            "everConnected": sorted(ever_connected),
            "userDisabled": sorted(user_disabled),
        },
        path,
    )
    return connector_payload(connector.id, state=updated_state)


def disabled_connector_skill_names(path: str | Path | None = None) -> set[str]:
    state = load_connector_state(path)
    enabled_ids = set(state["enabled"])
    disabled_ids = _all_connector_ids() - enabled_ids
    names: set[str] = set()
    for connector_id in disabled_ids:
        names.update(connector_skill_names(connector_id))
    return names


def is_skill_enabled_by_connectors(skill_name: str, path: str | Path | None = None) -> bool:
    safe_name = str(skill_name or "").strip()
    if not safe_name:
        return False
    return safe_name not in disabled_connector_skill_names(path)


def connector_payload(connector_id: str, *, state: dict[str, Any] | None = None) -> dict[str, Any]:
    connector = connector_definition(connector_id)
    safe_state = _normalize_state(state or load_connector_state())
    enabled_ids = set(safe_state["enabled"])
    ever_connected = set(safe_state["everConnected"])
    user_disabled = set(safe_state["userDisabled"])
    return {
        "id": connector.id,
        "name": connector.name,
        "description": connector.description,
        "kind": connector.kind,
        "enabled": connector.id in enabled_ids,
        "everConnected": connector.id in ever_connected,
        "userDisabled": connector.id in user_disabled,
        "skill_names": list(connector.skill_names),
        "skill_count": len(connector.skill_names),
    }


def connector_payloads(path: str | Path | None = None) -> list[dict[str, Any]]:
    state = load_connector_state(path)
    return [connector_payload(connector.id, state=state) for connector in connector_definitions()]
