from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_runtime.tool_executor import ToolExecutionContext, clear_tool_context, set_tool_context
from agent_runtime.tools import coding_tools
from agent_runtime.types import ToolExecutionError


def test_send_file_tool_passes_response_route_and_preserves_error(monkeypatch, tmp_path):
    workspace = tmp_path
    artifacts_root = workspace / "artifacts"
    artifacts_root.mkdir()
    artifact = artifacts_root / "result.csv"
    artifact.write_text("id,value\n1,ok\n", encoding="utf-8")
    calls: list[tuple[str, str, str]] = []

    async def fake_send_file(session_id: str, path: str, *, response_route_id: str = "") -> None:
        calls.append((session_id, path, response_route_id))
        raise RuntimeError("missing response route: route-1")

    monkeypatch.setattr(coding_tools, "WORKSPACE_ROOT", workspace)
    monkeypatch.setattr(coding_tools, "ARTIFACTS_ROOT", artifacts_root)
    monkeypatch.setattr(coding_tools, "send_file_to_current_session", fake_send_file)

    set_tool_context(
        ToolExecutionContext(
            session=SimpleNamespace(session_id="session-1"),
            response_route_id="route-1",
        )
    )
    try:
        with pytest.raises(ToolExecutionError, match="missing response route: route-1") as exc_info:
            asyncio.run(coding_tools._handle_send_file("artifacts/result.csv"))
    finally:
        clear_tool_context()

    assert str(exc_info.value.__cause__) == "missing response route: route-1"
    assert calls == [("session-1", str(Path(artifact).resolve()), "route-1")]
