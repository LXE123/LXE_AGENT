from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent_runtime.tools import coding_tools
from agent_runtime.types import ToolExecutionError


def _patch_workspace(monkeypatch: pytest.MonkeyPatch, workspace: Path) -> None:
    monkeypatch.setattr(coding_tools, "WORKSPACE_ROOT", workspace)
    monkeypatch.setattr(coding_tools, "ARTIFACTS_ROOT", workspace / "artifacts")
    monkeypatch.setattr(coding_tools, "SKILLS_ROOT", workspace / "skills")


def test_write_rejects_root_env_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _patch_workspace(monkeypatch, workspace)

    with pytest.raises(ToolExecutionError, match="写入被拒绝"):
        asyncio.run(coding_tools._handle_write(".env", "SECRET=1\n"))

    assert not (workspace / ".env").exists()


def test_edit_rejects_root_env_local_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    env_local = workspace / ".env.local"
    env_local.write_text("AGENT_LLM_MODEL=old\n", encoding="utf-8")
    _patch_workspace(monkeypatch, workspace)

    with pytest.raises(ToolExecutionError, match="写入被拒绝"):
        asyncio.run(coding_tools._handle_edit(".env.local", "old", "new"))

    assert env_local.read_text(encoding="utf-8") == "AGENT_LLM_MODEL=old\n"


def test_write_allows_env_example(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _patch_workspace(monkeypatch, workspace)

    result = asyncio.run(coding_tools._handle_write(".env.example", "EXAMPLE=\n"))

    assert "Wrote" in result.content[0]["text"]
    assert (workspace / ".env.example").read_text(encoding="utf-8") == "EXAMPLE=\n"


def test_write_allows_subdirectory_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _patch_workspace(monkeypatch, workspace)

    result = asyncio.run(coding_tools._handle_write("some_dir/.env", "LOCAL=1\n"))

    assert "Wrote" in result.content[0]["text"]
    assert (workspace / "some_dir" / ".env").read_text(encoding="utf-8") == "LOCAL=1\n"


def test_write_rejects_user_session_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _patch_workspace(monkeypatch, workspace)

    with pytest.raises(ToolExecutionError, match="写入被拒绝"):
        asyncio.run(coding_tools._handle_write("user_session_db/sessions.json", "{}\n"))

    assert not (workspace / "user_session_db" / "sessions.json").exists()


def test_write_rejects_symlink_into_user_session_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    session_db = workspace / "user_session_db"
    session_db.mkdir()
    link_path = workspace / "session_link"
    try:
        link_path.symlink_to(session_db, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"symlink unavailable: {exc}")
    _patch_workspace(monkeypatch, workspace)

    with pytest.raises(ToolExecutionError, match="写入被拒绝"):
        asyncio.run(coding_tools._handle_write("session_link/sessions.json", "{}\n"))

    assert not (session_db / "sessions.json").exists()
