from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from agent_runtime.packs.browser.tools import browser_tool_names
from agent_runtime.skill_index import load_skill_index
from agent_runtime.tool_registry import ensure_all_tools_registered, get_registry
from agent_runtime.tools.coding_tools import CODING_TOOL_NAMES
from agent_runtime.tools.feishu_im_tools import FEISHU_IM_TOOLS
from agent_runtime.tools.process_sessions import list_exec_session_snapshots
from shared.connector_state import (
    connector_payloads,
    is_skill_enabled_by_connectors,
    set_connector_enabled,
)
from shared.db.sqlite.engine import connection_scope
from shared.db.sqlite.session_messages import load_session_messages_page
from shared.env import upsert_project_local_config_values
from shared.llm.agent_planner import agent_planner_selection_options
from shared.llm.kimi_coding import client as kimi_coding_client
from shared.llm.model_capabilities import resolve_model_capabilities
from shared.llm.provider_catalog import (
    descriptor_for_provider,
    normalize_model_name,
    normalize_provider_name,
    provider_spec_for_name,
)
from shared.llm import runtime_config as runtime_settings
from shared.permission_policy import ALL, allowed_skill_types_for_bot
from platforms.feishu.config import FEISHU_APP_ID


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _dashboard_dist_dir() -> Path:
    return _repo_root() / "web" / "agent-dashboard" / "dist"


def _project_docs_root() -> Path:
    return _repo_root() / "docs"


_THINKING_ENABLED_ENV = "AGENT_LLM_THINKING_ENABLED"
_THINKING_EFFORT_ENV = "AGENT_LLM_THINKING_EFFORT"
_LLM_PROVIDER_ENV = "AGENT_LLM_PROVIDER"
_LLM_MODEL_ENV = "AGENT_LLM_MODEL"
_SELECTABLE_MODEL_PROVIDERS = {"kimi_coding", "deepseek"}


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    try:
        parsed = json.loads(str(value or "{}"))
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _capabilities_payload(provider_name: str, model_name: str) -> dict[str, Any]:
    capabilities = resolve_model_capabilities(provider_name, model_name)
    return {
        "provider": capabilities.provider,
        "model": capabilities.model,
        "context_window_tokens": capabilities.context_window_tokens,
        "max_tokens": capabilities.max_tokens,
        "max_output_tokens": capabilities.max_tokens,
        "supports_vision": capabilities.supports_vision,
        "supports_thinking": capabilities.supports_thinking,
        "supports_temperature": capabilities.supports_temperature,
    }


def _model_option_payload(provider_name: str, model_name: str) -> dict[str, Any]:
    descriptor = descriptor_for_provider(provider_name, model_override=model_name)
    return {
        "model": descriptor.default_model,
        "thinking_request_style": descriptor.thinking_request_style,
        "thinking_levels": list(descriptor.thinking_levels),
        "thinking_level_labels": dict(descriptor.thinking_level_labels),
        "thinking_default": descriptor.thinking_default,
        "capabilities": _capabilities_payload(descriptor.name, descriptor.default_model),
    }


def _model_options_payload(provider_name: str) -> list[dict[str, Any]]:
    spec = provider_spec_for_name(provider_name)
    return [_model_option_payload(spec.name, model_name) for model_name in spec.models]


def _provider_selectability(descriptor) -> tuple[bool, str]:
    if descriptor.name not in _SELECTABLE_MODEL_PROVIDERS:
        return False, "not selectable in WebUI"
    if not str(descriptor.api_key or "").strip():
        return False, "missing API key"
    return True, ""


def _descriptor_payload(descriptor) -> dict[str, Any]:
    selectable, disabled_reason = _provider_selectability(descriptor)
    return {
        "provider": descriptor.name,
        "label": descriptor.label,
        "api_style": descriptor.api_style,
        "model": descriptor.default_model,
        "configured": bool(str(descriptor.api_key or "").strip()),
        "selectable": selectable,
        "disabled_reason": disabled_reason,
        "model_options": _model_options_payload(descriptor.name),
        "thinking_request_style": descriptor.thinking_request_style,
        "thinking_levels": list(descriptor.thinking_levels),
        "thinking_level_labels": dict(descriptor.thinking_level_labels),
        "thinking_default": descriptor.thinking_default,
        "thinking_state": _thinking_state_payload(descriptor),
        "capabilities": _capabilities_payload(descriptor.name, descriptor.default_model),
    }


def _current_planner_descriptor():
    provider_name = os.getenv("AGENT_LLM_PROVIDER", "") or str(
        runtime_settings.AGENT_LLM_PROVIDER or kimi_coding_client.PROVIDER_NAME
    ).strip()
    model_name = os.getenv("AGENT_LLM_MODEL", "") or str(
        runtime_settings.AGENT_LLM_MODEL or ""
    ).strip()
    provider_name = normalize_provider_name(provider_name or kimi_coding_client.PROVIDER_NAME)
    return descriptor_for_provider(provider_name, model_override=model_name)


def _planner_descriptors_payload() -> list[dict[str, Any]]:
    current_descriptor = _current_planner_descriptor()
    items: list[dict[str, Any]] = []
    for descriptor in agent_planner_selection_options():
        if descriptor.name == current_descriptor.name:
            items.append(_descriptor_payload(current_descriptor))
        else:
            items.append(_descriptor_payload(descriptor))
    return items


def _thinking_levels_for_descriptor(descriptor) -> tuple[str, ...]:
    return tuple(
        str(level or "").strip().lower()
        for level in tuple(getattr(descriptor, "thinking_levels", ()) or ())
        if str(level or "").strip()
    )


def _is_editable_thinking_descriptor(descriptor) -> bool:
    levels = _thinking_levels_for_descriptor(descriptor)
    return bool(levels and "off" in levels)


def _default_enabled_thinking_level(descriptor) -> str:
    levels = _thinking_levels_for_descriptor(descriptor)
    default_level = str(getattr(descriptor, "thinking_default", "") or "").strip().lower()
    if default_level and default_level != "off" and default_level in levels:
        return default_level
    return next((level for level in levels if level != "off"), "off")


def _selected_thinking_level(descriptor) -> str:
    enabled = bool(getattr(runtime_settings, _THINKING_ENABLED_ENV, True))
    effort = str(getattr(runtime_settings, _THINKING_EFFORT_ENV, "low") or "low").strip().lower()
    levels = _thinking_levels_for_descriptor(descriptor)
    if not enabled or effort == "off":
        return "off"
    if levels:
        if effort in levels:
            return effort
        if effort == "xhigh" and "max" in levels:
            return "max"
        return _default_enabled_thinking_level(descriptor)
    return effort or "on"


def _thinking_state_payload(descriptor) -> dict[str, Any]:
    level = _selected_thinking_level(descriptor)
    return {
        "enabled": bool(level != "off"),
        "level": level,
        "editable": _is_editable_thinking_descriptor(descriptor),
    }


def _set_current_thinking_level(level: str) -> dict[str, Any]:
    descriptor = _current_planner_descriptor()
    normalized_level = str(level or "").strip().lower()
    levels = _thinking_levels_for_descriptor(descriptor)
    if not _is_editable_thinking_descriptor(descriptor):
        raise HTTPException(status_code=400, detail="Current model does not support editable thinking levels")
    if normalized_level not in levels:
        raise HTTPException(
            status_code=400,
            detail=f"Current model thinking level must be one of: {', '.join(levels)}",
        )

    enabled_level = _default_enabled_thinking_level(descriptor)
    env_values = {
        _THINKING_ENABLED_ENV: "0" if normalized_level == "off" else "1",
        _THINKING_EFFORT_ENV: enabled_level if normalized_level == "off" else normalized_level,
    }
    upsert_project_local_config_values(env_values)

    os.environ.update(env_values)
    setattr(runtime_settings, _THINKING_ENABLED_ENV, normalized_level != "off")
    setattr(runtime_settings, _THINKING_EFFORT_ENV, env_values[_THINKING_EFFORT_ENV])
    return _descriptor_payload(descriptor)


def _normalize_model_switch_thinking(descriptor) -> tuple[bool, str]:
    selected_level = _selected_thinking_level(descriptor)
    if selected_level == "off":
        return False, _default_enabled_thinking_level(descriptor)
    return True, selected_level


def _set_current_model(provider: str, model: str = "") -> dict[str, Any]:
    try:
        provider_name = normalize_provider_name(provider)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Unsupported model provider") from exc

    descriptor = descriptor_for_provider(provider_name)
    selectable, disabled_reason = _provider_selectability(descriptor)
    if not selectable:
        raise HTTPException(status_code=400, detail=disabled_reason or "Model provider is not selectable")

    spec = provider_spec_for_name(provider_name)
    requested_model = str(model or "").strip() or spec.default_model
    normalized_model = normalize_model_name(provider_name, requested_model)
    if normalized_model not in spec.models:
        raise HTTPException(status_code=400, detail="Unsupported model for provider")

    descriptor = descriptor_for_provider(provider_name, model_override=normalized_model)
    thinking_enabled, thinking_effort = _normalize_model_switch_thinking(descriptor)
    env_values = {
        _LLM_PROVIDER_ENV: provider_name,
        _LLM_MODEL_ENV: descriptor.default_model,
        _THINKING_ENABLED_ENV: "1" if thinking_enabled else "0",
        _THINKING_EFFORT_ENV: thinking_effort,
    }
    upsert_project_local_config_values(env_values)

    os.environ.update(env_values)
    setattr(runtime_settings, _LLM_PROVIDER_ENV, provider_name)
    setattr(runtime_settings, _LLM_MODEL_ENV, descriptor.default_model)
    setattr(runtime_settings, _THINKING_ENABLED_ENV, thinking_enabled)
    setattr(runtime_settings, _THINKING_EFFORT_ENV, thinking_effort)
    return _descriptor_payload(descriptor)


def _source_summary(source: dict[str, Any]) -> dict[str, str]:
    return {
        "platform": str(source.get("platform") or "unknown"),
        "chat_type": str(source.get("chat_type") or ""),
    }


def _session_row_payload(row) -> dict[str, Any]:
    source = _json_object(row["source"])
    return {
        "session_id": str(row["session_id"] or ""),
        "source": source,
        "source_summary": _source_summary(source),
        "model": str(row["model"] or ""),
        "model_config": _json_object(row["model_config"]),
        "created_at": float(row["created_at"] or 0),
        "last_active_at": float(row["last_active_at"] or 0),
        "message_count": int(row["message_count"] or 0),
        "tool_call_count": int(row["tool_call_count"] or 0),
        "input_tokens": int(row["input_tokens"] or 0),
        "output_tokens": int(row["output_tokens"] or 0),
        "title": str(row["title"] or ""),
        "api_call_count": int(row["api_call_count"] or 0),
    }


def _select_session_row(conn, *, session_id: str):
    return conn.execute(
        """
        SELECT
            session_id,
            source,
            model,
            model_config,
            created_at,
            last_active_at,
            message_count,
            tool_call_count,
            input_tokens,
            output_tokens,
            title,
            api_call_count
        FROM agent_sessions
        WHERE session_id = ?
        """,
        (session_id,),
    ).fetchone()


def _session_summary_payload() -> dict[str, int]:
    with connection_scope() as conn:
        row = conn.execute(
            """
            SELECT
                COUNT(*) AS total_sessions,
                COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS token_count
            FROM agent_sessions
            """
        ).fetchone()
    if row is None:
        return {"total_sessions": 0, "tool_call_count": 0, "token_count": 0}
    return {
        "total_sessions": int(row["total_sessions"] or 0),
        "tool_call_count": int(row["tool_call_count"] or 0),
        "token_count": int(row["token_count"] or 0),
    }


def _session_search_sql(query: str) -> tuple[str, tuple[str, ...]]:
    needle = str(query or "").strip().lower()
    if not needle:
        return "", ()
    like = f"%{needle}%"
    return (
        """
        WHERE lower(coalesce(session_id, '')) LIKE ?
           OR lower(coalesce(title, '')) LIKE ?
           OR lower(coalesce(model, '')) LIKE ?
           OR lower(coalesce(source, '')) LIKE ?
        """,
        (like, like, like, like),
    )


def _list_sessions(*, limit: int, offset: int, query: str = "") -> dict[str, Any]:
    safe_limit = max(1, min(int(limit), 200))
    safe_offset = max(0, int(offset))
    where_sql, where_args = _session_search_sql(query)
    with connection_scope() as conn:
        total_row = conn.execute(
            f"SELECT COUNT(*) AS count FROM agent_sessions {where_sql}",
            where_args,
        ).fetchone()
        rows = conn.execute(
            f"""
            SELECT
                session_id,
                source,
                model,
                model_config,
                created_at,
                last_active_at,
                message_count,
                tool_call_count,
                input_tokens,
                output_tokens,
                title,
                api_call_count
            FROM agent_sessions
            {where_sql}
            ORDER BY last_active_at DESC, created_at DESC, session_id ASC
            LIMIT ? OFFSET ?
            """,
            (*where_args, safe_limit, safe_offset),
        ).fetchall()
    return {
        "items": [_session_row_payload(row) for row in rows],
        "limit": safe_limit,
        "offset": safe_offset,
        "total": int(total_row["count"] if total_row is not None else 0),
        "summary": _session_summary_payload(),
    }


def _session_detail(session_id: str, *, message_limit: int = 10, message_page: int | None = None) -> dict[str, Any]:
    safe_session_id = str(session_id or "").strip()
    with connection_scope() as conn:
        row = _select_session_row(conn, session_id=safe_session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    session = _session_row_payload(row)
    messages_page = load_session_messages_page(
        session["session_id"],
        limit=message_limit,
        page=message_page,
    )
    return {
        "session": session,
        "messages": messages_page["messages"],
        "messages_page": messages_page["page"],
    }


def _current_allowed_skill_types() -> set[str]:
    current_bot_id = str(FEISHU_APP_ID or "").strip()
    return allowed_skill_types_for_bot(current_bot_id)


def _is_skill_allowed_for_current_agent(manifest) -> bool:
    allowed_types = _current_allowed_skill_types()
    if not allowed_types:
        return False
    allow_all = ALL in allowed_types
    if not (allow_all or str(manifest.type or "").strip() in allowed_types):
        return False
    return is_skill_enabled_by_connectors(manifest.name)


def _skills_payload() -> list[dict[str, Any]]:
    index = load_skill_index()
    items = []
    for manifest in sorted(index.all(), key=lambda item: item.name.casefold()):
        if not _is_skill_allowed_for_current_agent(manifest):
            continue
        items.append(
            {
                "name": manifest.name,
                "type": manifest.type,
                "description": manifest.description,
                "enabled": True,
                "location": str(manifest.body_path.resolve()),
                "references": [
                    {
                        "path": reference.path,
                        "description": reference.description,
                    }
                    for reference in manifest.references
                ],
            }
        )
    return items


def _skill_reference_payload(reference) -> dict[str, str]:
    return {
        "path": str(reference.path or ""),
        "description": str(reference.description or ""),
    }


def _skill_metadata_payload(manifest) -> dict[str, Any]:
    return {
        "name": manifest.name,
        "type": manifest.type,
        "description": manifest.description,
        "location": str(manifest.body_path.resolve()),
        "references": [_skill_reference_payload(reference) for reference in manifest.references],
    }


def _skill_manifest_or_404(skill_name: str):
    manifest = load_skill_index().get(skill_name)
    if manifest is None or not _is_skill_allowed_for_current_agent(manifest):
        raise HTTPException(status_code=404, detail="skill not found")
    return manifest


def _read_utf8_file_or_http_error(path: Path, *, not_found_detail: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=not_found_detail) from exc
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=500, detail="file is not valid utf-8 text") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="failed to read file") from exc


def _extract_markdown_title(content: str, fallback: str) -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip() or fallback
    return fallback


def _extract_markdown_status(content: str) -> str:
    lines = content.splitlines()
    if lines and lines[0].strip() == "---":
        for line in lines[1:]:
            stripped = line.strip()
            if stripped == "---":
                break
            key, separator, value = stripped.partition(":")
            if separator and key.strip().lower() == "status":
                return value.strip().strip('"\'')
    for line in lines[:20]:
        stripped = line.strip()
        if stripped.startswith("状态："):
            return stripped.removeprefix("状态：").strip()
        key, separator, value = stripped.partition(":")
        if separator and key.strip().lower() == "status":
            return value.strip()
    return ""


def _doc_title_from_path(relative_path: str) -> str:
    stem = Path(relative_path).stem.replace("_", " ").replace("-", " ").strip()
    return stem or relative_path


def _project_doc_metadata_payload(path: Path, root: Path) -> dict[str, Any]:
    relative_path = path.relative_to(root).as_posix()
    content = _read_utf8_file_or_http_error(path, not_found_detail="project doc not found")
    parent = Path(relative_path).parent.as_posix()
    return {
        "path": relative_path,
        "title": _extract_markdown_title(content, _doc_title_from_path(relative_path)),
        "section": "" if parent == "." else parent,
        "status": _extract_markdown_status(content),
        "size": path.stat().st_size,
    }


def _project_docs_payload() -> list[dict[str, Any]]:
    root = _project_docs_root().resolve()
    if not root.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*.md"), key=lambda item: item.relative_to(root).as_posix().casefold()):
        resolved = path.resolve()
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        if not resolved.is_file():
            continue
        items.append(_project_doc_metadata_payload(resolved, root))
    return items


def _normalize_project_doc_request_path(doc_path: str) -> str:
    raw_path = str(doc_path or "").strip().replace("\\", "/")
    if not raw_path:
        raise HTTPException(status_code=404, detail="project doc not found")
    if raw_path.startswith("/") or raw_path.startswith("~") or ":" in raw_path:
        raise HTTPException(status_code=404, detail="project doc not found")
    parts = [part for part in raw_path.split("/") if part]
    if any(part in {".", ".."} for part in parts):
        raise HTTPException(status_code=404, detail="project doc not found")
    safe_path = "/".join(parts)
    if not safe_path.lower().endswith(".md"):
        raise HTTPException(status_code=404, detail="project doc not found")
    return safe_path


def _project_doc_path_or_404(doc_path: str) -> Path:
    root = _project_docs_root().resolve()
    safe_path = _normalize_project_doc_request_path(doc_path)
    path = (root / safe_path).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="project doc not found") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="project doc not found")
    return path


def _project_doc_content_payload(doc_path: str) -> dict[str, Any]:
    root = _project_docs_root().resolve()
    path = _project_doc_path_or_404(doc_path)
    metadata = _project_doc_metadata_payload(path, root)
    return {
        **metadata,
        "content": _read_utf8_file_or_http_error(path, not_found_detail="project doc not found"),
    }


def _skill_content_payload(skill_name: str) -> dict[str, Any]:
    manifest = _skill_manifest_or_404(skill_name)
    return {
        **_skill_metadata_payload(manifest),
        "content": _read_utf8_file_or_http_error(manifest.body_path, not_found_detail="skill content not found"),
    }


def _normalize_reference_request_path(reference_path: str) -> str:
    return str(reference_path or "").strip().replace("\\", "/").lstrip("/")


def _skill_reference_content_payload(skill_name: str, reference_path: str) -> dict[str, Any]:
    manifest = _skill_manifest_or_404(skill_name)
    safe_reference_path = _normalize_reference_request_path(reference_path)
    reference = next(
        (
            item
            for item in manifest.references
            if _normalize_reference_request_path(item.path) == safe_reference_path
        ),
        None,
    )
    if reference is None:
        raise HTTPException(status_code=404, detail="skill reference not found")

    root_dir = manifest.root_dir.resolve()
    content_path = (manifest.root_dir / reference.path).resolve()
    if root_dir not in content_path.parents and content_path != root_dir:
        raise HTTPException(status_code=404, detail="skill reference not found")

    return {
        "skill_name": manifest.name,
        "path": reference.path,
        "description": reference.description,
        "location": str(content_path),
        "content": _read_utf8_file_or_http_error(content_path, not_found_detail="skill reference not found"),
    }


def _tool_payload(name: str) -> dict[str, Any] | None:
    registry = ensure_all_tools_registered(get_registry())
    tool = registry.get(name)
    if tool is None:
        return None
    return {
        "name": tool.name,
        "description": tool.description,
        "parameters": dict(tool.parameters or {}),
        "requires_resource": tool.requires_resource,
        "enabled": True,
    }


def _toolset_payload(name: str, label: str, tool_names: list[str]) -> dict[str, Any]:
    tools = []
    for tool_name in sorted({str(item or "").strip() for item in tool_names if str(item or "").strip()}):
        tool = _tool_payload(tool_name)
        if tool is not None:
            tools.append(tool)
    return {
        "name": name,
        "label": label,
        "enabled": bool(tools),
        "tools": tools,
    }


def _toolsets_payload() -> list[dict[str, Any]]:
    return [
        _toolset_payload("coding", "Coding", list(CODING_TOOL_NAMES)),
        _toolset_payload(
            "feishu_im",
            "Feishu IM",
            [tool.name for tool in FEISHU_IM_TOOLS],
        ),
        _toolset_payload("browser", "Browser", list(browser_tool_names())),
    ]


def _session_titles_by_id(session_ids: list[str]) -> dict[str, str]:
    safe_ids = sorted({str(item or "").strip() for item in session_ids if str(item or "").strip()})
    if not safe_ids:
        return {}
    placeholders = ",".join("?" for _ in safe_ids)
    with connection_scope() as conn:
        rows = conn.execute(
            f"""
            SELECT session_id, title
            FROM agent_sessions
            WHERE session_id IN ({placeholders})
            """,
            tuple(safe_ids),
        ).fetchall()
    return {str(row["session_id"] or ""): str(row["title"] or "") for row in rows}


def _background_tasks_payload() -> list[dict[str, Any]]:
    items = [dict(item) for item in list_exec_session_snapshots()]
    titles = _session_titles_by_id([str(item.get("session_id") or "") for item in items])
    for item in items:
        session_id = str(item.get("session_id") or "").strip()
        item["session_title"] = titles.get(session_id, "")
    return items


def create_dashboard_app() -> FastAPI:
    app = FastAPI(
        title="Agent Dashboard",
        version="1.0.0",
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_credentials=False,
        allow_methods=["GET", "PATCH"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "service": "agent-dashboard"}

    @app.get("/api/sessions")
    async def sessions(
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        q: str = Query(default=""),
    ) -> dict[str, Any]:
        return _list_sessions(limit=limit, offset=offset, query=q)

    @app.get("/api/sessions/{session_id}")
    async def session_detail(
        session_id: str,
        message_limit: int = Query(default=10, ge=1, le=200),
        message_page: int | None = Query(default=None, ge=1),
    ) -> dict[str, Any]:
        return _session_detail(session_id, message_limit=message_limit, message_page=message_page)

    @app.get("/api/skills")
    async def skills() -> dict[str, Any]:
        items = _skills_payload()
        return {"items": items, "total": len(items)}

    @app.get("/api/connectors")
    async def connectors() -> dict[str, Any]:
        items = connector_payloads()
        return {"items": items, "total": len(items)}

    @app.patch("/api/connectors/{connector_id}")
    async def update_connector(connector_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        safe_payload = dict(payload or {})
        enabled = safe_payload.get("enabled")
        if not isinstance(enabled, bool):
            raise HTTPException(status_code=400, detail="enabled must be a boolean")
        try:
            return set_connector_enabled(connector_id, enabled)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="connector not found") from exc

    @app.get("/api/skills/{skill_name}/content")
    async def skill_content(skill_name: str) -> dict[str, Any]:
        return _skill_content_payload(skill_name)

    @app.get("/api/skills/{skill_name}/references/{reference_path:path}")
    async def skill_reference_content(skill_name: str, reference_path: str) -> dict[str, Any]:
        return _skill_reference_content_payload(skill_name, reference_path)

    @app.get("/api/tools/toolsets")
    async def toolsets() -> dict[str, Any]:
        items = _toolsets_payload()
        return {"items": items, "total": len(items)}

    @app.get("/api/background-tasks")
    async def background_tasks() -> dict[str, Any]:
        items = _background_tasks_payload()
        return {"items": items, "total": len(items)}

    @app.get("/api/project-docs")
    async def project_docs() -> dict[str, Any]:
        items = _project_docs_payload()
        return {"items": items, "total": len(items)}

    @app.get("/api/project-docs/{doc_path:path}")
    async def project_doc_content(doc_path: str) -> dict[str, Any]:
        return _project_doc_content_payload(doc_path)

    @app.get("/api/models")
    async def models() -> dict[str, Any]:
        items = _planner_descriptors_payload()
        return {"items": items, "total": len(items)}

    @app.get("/api/models/current")
    async def current_model() -> dict[str, Any]:
        return _descriptor_payload(_current_planner_descriptor())

    @app.patch("/api/models/current")
    async def update_current_model(payload: dict[str, Any]) -> dict[str, Any]:
        safe_payload = dict(payload or {})
        return _set_current_model(
            str(safe_payload.get("provider") or ""),
            str(safe_payload.get("model") or ""),
        )

    @app.patch("/api/models/current/thinking")
    async def update_current_model_thinking(payload: dict[str, Any]) -> dict[str, Any]:
        return _set_current_thinking_level(str(dict(payload or {}).get("level") or ""))

    dist_dir = _dashboard_dist_dir()
    if dist_dir.is_dir():
        index_file = dist_dir / "index.html"

        @app.get("/docs")
        @app.get("/docs/{path:path}")
        async def docs_frontend(path: str = "") -> FileResponse:
            return FileResponse(index_file)

        app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="dashboard")
    else:
        @app.get("/")
        async def dashboard_not_built() -> HTMLResponse:
            return HTMLResponse(
                "<!doctype html><meta charset='utf-8'>"
                "<title>Agent Dashboard</title>"
                "<body style='font-family:system-ui;margin:40px'>"
                "<h1>Agent Dashboard API is running</h1>"
                "<p>Build the React app in <code>web/agent-dashboard</code> to serve the UI.</p>"
                "<p>API docs: <a href='/api/docs'>/api/docs</a></p>"
                "</body>",
            )

        @app.get("/docs")
        @app.get("/docs/{path:path}")
        async def docs_not_built(path: str = "") -> HTMLResponse:
            return await dashboard_not_built()

    return app


__all__ = ["create_dashboard_app"]
