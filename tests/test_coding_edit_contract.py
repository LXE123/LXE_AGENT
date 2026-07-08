from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from agent_runtime.tools import coding_tools
from agent_runtime.types import ToolExecutionError


def _patch_workspace(monkeypatch: pytest.MonkeyPatch, workspace: Path) -> None:
    monkeypatch.setattr(coding_tools, "WORKSPACE_ROOT", workspace)
    monkeypatch.setattr(coding_tools, "ARTIFACTS_ROOT", workspace / "artifacts")
    monkeypatch.setattr(coding_tools, "SKILLS_ROOT", workspace / "skills")


@pytest.fixture(autouse=True)
def _clean_ledger():
    coding_tools.clear_file_read_ledger_for_tests()
    yield
    coding_tools.clear_file_read_ledger_for_tests()


def _make_workspace(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _patch_workspace(monkeypatch, workspace)
    return workspace


def _read(path: str, **kwargs):
    return asyncio.run(coding_tools._handle_read(path, **kwargs))


def _text(result) -> str:
    return result.content[0]["text"]


def test_read_returns_line_numbers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "a.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")

    text = _text(_read("a.txt"))

    assert text.splitlines() == [
        f"{1:6d}\talpha",
        f"{2:6d}\tbeta",
        f"{3:6d}\tgamma",
    ]


def test_read_offset_keeps_absolute_line_numbers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "a.txt").write_text("l1\nl2\nl3\nl4\n", encoding="utf-8")

    text = _text(_read("a.txt", offset=3))

    assert text.splitlines()[0] == f"{3:6d}\tl3"


def test_read_allows_external_agent_skill_files_read_only(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _make_workspace(monkeypatch, tmp_path)
    external_root = tmp_path / "agent-skills"
    skill_dir = external_root / "external-skill"
    skill_dir.mkdir(parents=True)
    skill_path = skill_dir / "SKILL.md"
    skill_path.write_text("# External Skill\n\nRead-only body.\n", encoding="utf-8")
    monkeypatch.setattr(coding_tools, "EXTERNAL_SKILLS_ROOTS", (external_root,), raising=False)

    text = _text(_read(str(skill_path)))

    assert f"{1:6d}\t# External Skill" in text
    with pytest.raises(ToolExecutionError, match="路径越界"):
        asyncio.run(coding_tools._handle_write(str(skill_path), "changed\n"))
    assert skill_path.read_text(encoding="utf-8") == "# External Skill\n\nRead-only body.\n"


def test_edit_rejects_unread_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "a.txt").write_text("hello\n", encoding="utf-8")

    with pytest.raises(ToolExecutionError, match="先用 read 读取"):
        asyncio.run(coding_tools._handle_edit("a.txt", "hello", "world"))

    assert (workspace / "a.txt").read_text(encoding="utf-8") == "hello\n"


def test_edit_works_after_read_and_consecutive_edits(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    target = workspace / "a.txt"
    target.write_text("hello\n", encoding="utf-8")

    _read("a.txt")
    asyncio.run(coding_tools._handle_edit("a.txt", "hello", "world"))
    # 第二次 edit 无需重新 read（台账已随写入更新）
    asyncio.run(coding_tools._handle_edit("a.txt", "world", "again"))

    assert target.read_text(encoding="utf-8") == "again\n"


def test_edit_rejects_stale_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    target = workspace / "a.txt"
    target.write_text("hello\n", encoding="utf-8")

    _read("a.txt")
    # 模拟外部修改：内容与 mtime 都变化
    target.write_text("hello external\n", encoding="utf-8")
    stat = target.stat()
    os.utime(target, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))

    with pytest.raises(ToolExecutionError, match="被修改过"):
        asyncio.run(coding_tools._handle_edit("a.txt", "hello", "world"))

    # 重新 read 后恢复可编辑
    _read("a.txt")
    asyncio.run(coding_tools._handle_edit("a.txt", "hello external", "ok"))
    assert target.read_text(encoding="utf-8") == "ok\n"


def test_write_new_file_needs_no_read(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)

    result = asyncio.run(coding_tools._handle_write("new.txt", "content\n"))

    assert "Wrote" in _text(result)
    assert (workspace / "new.txt").read_text(encoding="utf-8") == "content\n"


def test_write_rejects_overwriting_unread_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "a.txt").write_text("original\n", encoding="utf-8")

    with pytest.raises(ToolExecutionError, match="先用 read 读取"):
        asyncio.run(coding_tools._handle_write("a.txt", "clobbered\n"))

    assert (workspace / "a.txt").read_text(encoding="utf-8") == "original\n"


def test_write_overwrite_allowed_after_read(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "a.txt").write_text("original\n", encoding="utf-8")

    _read("a.txt")
    asyncio.run(coding_tools._handle_write("a.txt", "updated\n"))

    assert (workspace / "a.txt").read_text(encoding="utf-8") == "updated\n"


def test_write_then_overwrite_own_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)

    asyncio.run(coding_tools._handle_write("a.txt", "v1\n"))
    # 自己刚写的文件可以直接再写 / edit，无需 read
    asyncio.run(coding_tools._handle_write("a.txt", "v2\n"))
    asyncio.run(coding_tools._handle_edit("a.txt", "v2", "v3"))

    assert (workspace / "a.txt").read_text(encoding="utf-8") == "v3\n"


def test_write_rejects_directory_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "some_dir").mkdir()

    with pytest.raises(ToolExecutionError, match="不是普通文件"):
        asyncio.run(coding_tools._handle_write("some_dir", "x\n"))


def test_edit_replace_all(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    target = workspace / "a.txt"
    target.write_text("foo bar foo baz foo\n", encoding="utf-8")

    _read("a.txt")
    result = asyncio.run(coding_tools._handle_edit("a.txt", "foo", "qux", replace_all=True))

    assert "replaced 3 occurrences" in _text(result)
    assert target.read_text(encoding="utf-8") == "qux bar qux baz qux\n"


def test_edit_multi_match_without_replace_all_errors(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "a.txt").write_text("foo foo\n", encoding="utf-8")

    _read("a.txt")
    with pytest.raises(ToolExecutionError, match="replace_all"):
        asyncio.run(coding_tools._handle_edit("a.txt", "foo", "bar"))


def test_edit_rejects_identical_and_empty_old_string(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / "a.txt").write_text("hello\n", encoding="utf-8")
    _read("a.txt")

    with pytest.raises(ToolExecutionError, match="不能为空"):
        asyncio.run(coding_tools._handle_edit("a.txt", "", "x"))
    with pytest.raises(ToolExecutionError, match="必须和 old_string 不同"):
        asyncio.run(coding_tools._handle_edit("a.txt", "hello", "hello"))


def test_write_denied_check_precedes_contract(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    workspace = _make_workspace(monkeypatch, tmp_path)
    (workspace / ".env").write_text("SECRET=1\n", encoding="utf-8")

    # 保护路径的报错必须仍是"写入被拒绝"，而不是契约报错
    with pytest.raises(ToolExecutionError, match="写入被拒绝"):
        asyncio.run(coding_tools._handle_write(".env", "X=1\n"))
