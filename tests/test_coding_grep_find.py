from __future__ import annotations

import asyncio
import os
import shutil
import time
from pathlib import Path

import pytest

from agent_runtime.tools import coding_tools
from agent_runtime.types import ToolExecutionError


def _patch_workspace(monkeypatch: pytest.MonkeyPatch, workspace: Path) -> None:
    monkeypatch.setattr(coding_tools, "WORKSPACE_ROOT", workspace)
    monkeypatch.setattr(coding_tools, "ARTIFACTS_ROOT", workspace / "artifacts")
    monkeypatch.setattr(coding_tools, "SKILLS_ROOT", workspace / "skills")


def _force_grep_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(coding_tools, "_ripgrep_executable", lambda: "")


def _make_workspace(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _patch_workspace(monkeypatch, workspace)
    return workspace


def _result_text(result) -> str:
    return result.content[0]["text"]


def test_grep_default_mode_lists_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("alpha\nbeta\n", encoding="utf-8")
    (workspace / "b.txt").write_text("gamma\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_grep("beta")))

    assert text == "a.py"


def test_grep_content_mode_shows_line_numbers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("alpha\nbeta\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_grep("beta", output_mode="content")))

    assert text == "a.py:2:beta"


def test_grep_count_mode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("beta\nbeta\nother\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_grep("beta", output_mode="count")))

    assert text == "a.py:2"


def test_grep_case_insensitive(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("BETA\n", encoding="utf-8")

    default = _result_text(asyncio.run(coding_tools._handle_grep("beta")))
    insensitive = _result_text(asyncio.run(coding_tools._handle_grep("beta", case_insensitive=True)))

    assert default == "No matches found."
    assert insensitive == "a.py"


def test_grep_glob_filters_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("beta\n", encoding="utf-8")
    (workspace / "b.txt").write_text("beta\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_grep("beta", glob="*.py")))

    assert text == "a.py"


def test_grep_glob_negation_excludes_files(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("beta\n", encoding="utf-8")
    (workspace / "b.txt").write_text("beta\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_grep("beta", glob="!*.py")))

    assert text == "b.txt"


def test_grep_type_filter_fallback(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("beta\n", encoding="utf-8")
    (workspace / "b.txt").write_text("beta\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_grep("beta", type="py")))

    assert text == "a.py"

    with pytest.raises(ToolExecutionError, match="未知 type"):
        asyncio.run(coding_tools._handle_grep("beta", type="nosuchtype"))


def test_grep_content_context_lines(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("l1\nl2\nbeta\nl4\nl5\n", encoding="utf-8")

    text = _result_text(
        asyncio.run(coding_tools._handle_grep("beta", output_mode="content", context=1))
    )

    assert text.splitlines() == ["a.py-2-l2", "a.py:3:beta", "a.py-4-l4"]


def test_grep_head_limit_truncates(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("".join(f"beta {i}\n" for i in range(10)), encoding="utf-8")

    text = _result_text(
        asyncio.run(coding_tools._handle_grep("beta", output_mode="content", head_limit=3))
    )

    lines = text.splitlines()
    assert len(lines) == 4
    assert "more lines" in lines[-1]


def test_grep_multiline_fallback(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    (workspace / "a.py").write_text("start\nmiddle\nend\n", encoding="utf-8")

    text = _result_text(
        asyncio.run(
            coding_tools._handle_grep("start.*end", output_mode="content", multiline=True)
        )
    )

    assert text == "a.py:1:start"


def test_grep_skips_skip_dirs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)
    nested = workspace / "node_modules" / "pkg"
    nested.mkdir(parents=True)
    (nested / "a.js").write_text("beta\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_grep("beta")))

    assert text == "No matches found."


def test_grep_rejects_empty_pattern(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)

    with pytest.raises(ToolExecutionError, match="pattern 不能为空"):
        asyncio.run(coding_tools._handle_grep(""))


def test_grep_rejects_unknown_output_mode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _make_workspace(monkeypatch, tmp_path)
    _force_grep_fallback(monkeypatch)

    with pytest.raises(ToolExecutionError, match="未知 output_mode"):
        asyncio.run(coding_tools._handle_grep("beta", output_mode="lines"))


@pytest.mark.skipif(not shutil.which("rg"), reason="ripgrep not installed")
def test_grep_ripgrep_content_mode(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "a.py").write_text("alpha\nbeta\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_grep("beta", output_mode="content")))

    assert "a.py" in text
    assert ":2:" in text
    assert "beta" in text


@pytest.mark.skipif(not shutil.which("rg"), reason="ripgrep not installed")
def test_grep_ripgrep_no_matches(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "a.py").write_text("alpha\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_grep("nomatch")))

    assert text == "No matches found."


def test_find_sorts_by_mtime_newest_first(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    old = workspace / "old.py"
    new = workspace / "sub" / "new.py"
    old.write_text("old\n", encoding="utf-8")
    new.parent.mkdir()
    new.write_text("new\n", encoding="utf-8")
    now = time.time()
    os.utime(old, (now - 3600, now - 3600))
    os.utime(new, (now, now))

    text = _result_text(asyncio.run(coding_tools._handle_find("*.py")))

    assert text.splitlines() == ["sub/new.py", "old.py"]


def test_find_matches_relative_path_glob(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    target = workspace / "skills" / "demo" / "SKILL.md"
    target.parent.mkdir(parents=True)
    target.write_text("# demo\n", encoding="utf-8")
    (workspace / "README.md").write_text("# readme\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_find("skills/**/SKILL.md")))

    assert text == "skills/demo/SKILL.md"


def test_find_skips_skip_dirs_and_limits(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    hidden = workspace / "node_modules" / "x.py"
    hidden.parent.mkdir()
    hidden.write_text("x\n", encoding="utf-8")
    for i in range(5):
        (workspace / f"f{i}.py").write_text(f"{i}\n", encoding="utf-8")

    text = _result_text(asyncio.run(coding_tools._handle_find("*.py", head_limit=3)))

    lines = text.splitlines()
    assert len(lines) == 4
    assert "showing first 3 of 5" in lines[-1]
    assert all("node_modules" not in line for line in lines)


def test_find_rejects_empty_pattern(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _make_workspace(monkeypatch, tmp_path)

    with pytest.raises(ToolExecutionError, match="pattern 不能为空"):
        asyncio.run(coding_tools._handle_find(""))


def test_grep_and_find_registered_in_coding_tools() -> None:
    names = {tool.name for tool in coding_tools.CODING_TOOLS}
    assert {"grep", "find"} <= names
    assert {"grep", "find"} <= coding_tools.CODING_TOOL_NAMES
