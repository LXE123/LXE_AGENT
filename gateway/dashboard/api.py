from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from agent_runtime.packs.browser.tools import browser_tool_names
from agent_runtime.skill_index import load_skill_index
from agent_runtime.tool_registry import ensure_all_tools_registered, get_registry
from agent_runtime.tools.coding_tools import CODING_TOOL_NAMES
from agent_runtime.tools.feishu_im_tools import FEISHU_IM_TOOLS
from agent_runtime.tools.process_sessions import list_exec_session_snapshots
from shared.config import config
from shared.db.sqlite.engine import connection_scope
from shared.db.sqlite.session_messages import load_session_messages_page
from shared.llm.agent_planner import agent_planner_selection_options
from shared.llm.kimi_coding import client as kimi_coding_client
from shared.llm.model_capabilities import resolve_model_capabilities
from shared.llm.provider_catalog import descriptor_for_provider, normalize_provider_name
from shared.permission_policy import ALL, allowed_skill_types_for_bot


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _dashboard_dist_dir() -> Path:
    return _repo_root() / "web" / "agent-dashboard" / "dist"


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


def _descriptor_payload(descriptor) -> dict[str, Any]:
    return {
        "provider": descriptor.name,
        "label": descriptor.label,
        "api_style": descriptor.api_style,
        "model": descriptor.default_model,
        "configured": bool(str(descriptor.api_key or "").strip()),
        "capabilities": _capabilities_payload(descriptor.name, descriptor.default_model),
    }


def _current_planner_descriptor():
    provider_name = os.getenv("AGENT_LLM_PROVIDER", "") or str(
        getattr(config, "AGENT_LLM_PROVIDER", kimi_coding_client.PROVIDER_NAME) or ""
    ).strip()
    model_name = os.getenv("AGENT_LLM_MODEL", "") or str(
        getattr(config, "AGENT_LLM_MODEL", "") or ""
    ).strip()
    provider_name = normalize_provider_name(provider_name or kimi_coding_client.PROVIDER_NAME)
    return descriptor_for_provider(provider_name, model_override=model_name)


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


def _list_sessions(*, limit: int, offset: int) -> dict[str, Any]:
    safe_limit = max(1, min(int(limit), 200))
    safe_offset = max(0, int(offset))
    with connection_scope() as conn:
        total_row = conn.execute("SELECT COUNT(*) AS count FROM agent_sessions").fetchone()
        rows = conn.execute(
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
            ORDER BY last_active_at DESC, created_at DESC, session_id ASC
            LIMIT ? OFFSET ?
            """,
            (safe_limit, safe_offset),
        ).fetchall()
    return {
        "items": [_session_row_payload(row) for row in rows],
        "limit": safe_limit,
        "offset": safe_offset,
        "total": int(total_row["count"] if total_row is not None else 0),
    }


def _session_detail(session_id: str, *, message_limit: int = 25, message_page: int | None = None) -> dict[str, Any]:
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


def _skills_payload() -> list[dict[str, Any]]:
    index = load_skill_index()
    current_bot_id = str(getattr(config, "FEISHU_APP_ID", "") or "").strip()
    allowed_types = allowed_skill_types_for_bot(current_bot_id)
    allow_all = ALL in allowed_types
    items = []
    for manifest in sorted(index.all(), key=lambda item: item.name.casefold()):
        enabled = allow_all or str(manifest.type or "").strip() in allowed_types
        items.append(
            {
                "name": manifest.name,
                "type": manifest.type,
                "description": manifest.description,
                "enabled": bool(enabled),
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
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "service": "agent-dashboard"}

    @app.get("/api/sessions")
    async def sessions(
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ) -> dict[str, Any]:
        return _list_sessions(limit=limit, offset=offset)

    @app.get("/api/sessions/{session_id}")
    async def session_detail(
        session_id: str,
        message_limit: int = Query(default=25, ge=1, le=200),
        message_page: int | None = Query(default=None, ge=1),
    ) -> dict[str, Any]:
        return _session_detail(session_id, message_limit=message_limit, message_page=message_page)

    @app.get("/api/skills")
    async def skills() -> dict[str, Any]:
        items = _skills_payload()
        return {"items": items, "total": len(items)}

    @app.get("/api/tools/toolsets")
    async def toolsets() -> dict[str, Any]:
        items = _toolsets_payload()
        return {"items": items, "total": len(items)}

    @app.get("/api/background-tasks")
    async def background_tasks() -> dict[str, Any]:
        items = _background_tasks_payload()
        return {"items": items, "total": len(items)}

    @app.get("/api/models")
    async def models() -> dict[str, Any]:
        items = [_descriptor_payload(descriptor) for descriptor in agent_planner_selection_options()]
        return {"items": items, "total": len(items)}

    @app.get("/api/models/current")
    async def current_model() -> dict[str, Any]:
        return _descriptor_payload(_current_planner_descriptor())

    dist_dir = _dashboard_dist_dir()
    if dist_dir.is_dir():
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

    return app


__all__ = ["create_dashboard_app"]
