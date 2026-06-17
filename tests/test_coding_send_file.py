from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_runtime.tool_executor import ToolExecutionContext, clear_tool_context, set_tool_context
from agent_runtime.tools import coding_tools
from agent_runtime.types import ToolExecutionError


def _patch_send_roots(monkeypatch, workspace: Path) -> None:
    monkeypatch.setattr(coding_tools, "WORKSPACE_ROOT", workspace)
    monkeypatch.setattr(coding_tools, "ARTIFACTS_ROOT", workspace / "artifacts")
    monkeypatch.setattr(coding_tools, "SKILLS_ROOT", workspace / "skills")


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

    _patch_send_roots(monkeypatch, workspace)
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


def test_send_file_tool_allows_skill_asset_relative_path(monkeypatch, tmp_path):
    workspace = tmp_path
    asset = workspace / "skills" / "demo-skill" / "assets" / "guide.jpg"
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b"image")
    calls: list[tuple[str, str, str]] = []

    async def fake_send_file(session_id: str, path: str, *, response_route_id: str = "") -> None:
        calls.append((session_id, path, response_route_id))

    _patch_send_roots(monkeypatch, workspace)
    monkeypatch.setattr(coding_tools, "send_file_to_current_session", fake_send_file)

    set_tool_context(
        ToolExecutionContext(
            session=SimpleNamespace(session_id="session-1"),
            response_route_id="route-1",
        )
    )
    try:
        result = asyncio.run(coding_tools._handle_send_file("skills/demo-skill/assets/guide.jpg"))
    finally:
        clear_tool_context()

    assert calls == [("session-1", str(asset.resolve()), "route-1")]
    assert "已发送文件到当前会话: skills/demo-skill/assets/guide.jpg" in result.content[0]["text"]


def test_send_file_tool_allows_skill_asset_absolute_path(monkeypatch, tmp_path):
    workspace = tmp_path
    asset = workspace / "skills" / "demo-skill" / "assets" / "guide.jpg"
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b"image")
    calls: list[tuple[str, str, str]] = []

    async def fake_send_file(session_id: str, path: str, *, response_route_id: str = "") -> None:
        calls.append((session_id, path, response_route_id))

    _patch_send_roots(monkeypatch, workspace)
    monkeypatch.setattr(coding_tools, "send_file_to_current_session", fake_send_file)

    set_tool_context(
        ToolExecutionContext(
            session=SimpleNamespace(session_id="session-1"),
            response_route_id="route-1",
        )
    )
    try:
        result = asyncio.run(coding_tools._handle_send_file(str(asset)))
    finally:
        clear_tool_context()

    assert calls == [("session-1", str(asset.resolve()), "route-1")]
    assert "已发送文件到当前会话: skills/demo-skill/assets/guide.jpg" in result.content[0]["text"]


@pytest.mark.parametrize(
    "bad_path",
    [
        "skills/demo-skill/SKILL.md",
        "skills/demo-skill/references/example.md",
        "../outside.jpg",
    ],
)
def test_send_file_tool_rejects_non_sendable_paths(monkeypatch, tmp_path, bad_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "skills" / "demo-skill" / "references").mkdir(parents=True)
    (workspace / "skills" / "demo-skill" / "SKILL.md").write_text("skill", encoding="utf-8")
    (workspace / "skills" / "demo-skill" / "references" / "example.md").write_text("ref", encoding="utf-8")

    _patch_send_roots(monkeypatch, workspace)

    with pytest.raises(ToolExecutionError, match="路径越界"):
        asyncio.run(coding_tools._handle_send_file(bad_path))


def test_send_file_tool_rejects_skill_asset_symlink_escape(monkeypatch, tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.jpg"
    outside.write_bytes(b"outside")
    asset_link = workspace / "skills" / "demo-skill" / "assets" / "outside.jpg"
    asset_link.parent.mkdir(parents=True)
    try:
        asset_link.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlink unavailable: {exc}")

    _patch_send_roots(monkeypatch, workspace)

    with pytest.raises(ToolExecutionError, match="路径越界"):
        asyncio.run(coding_tools._handle_send_file("skills/demo-skill/assets/outside.jpg"))
