from __future__ import annotations

from pathlib import Path

import pytest

from shared.repository import find_repository_root


def _write_repository_markers(root: Path) -> None:
    (root / "config").mkdir(parents=True)
    (root / "skills").mkdir()
    (root / "package.json").write_text("{}\n", encoding="utf-8")
    (root / "pyproject.toml").write_text("[project]\n", encoding="utf-8")


def test_explicit_lxe_root_supports_frozen_runtime_assets(tmp_path: Path) -> None:
    root = tmp_path / "安装目录 中文"
    _write_repository_markers(root)

    assert find_repository_root(tmp_path, environment={"LXE_ROOT": str(root)}) == root


def test_invalid_explicit_lxe_root_does_not_silently_fall_back(tmp_path: Path) -> None:
    root = tmp_path / "repository"
    _write_repository_markers(root)

    with pytest.raises(RuntimeError, match="LXE_ROOT is not an LXE repository root"):
        find_repository_root(root, environment={"LXE_ROOT": str(tmp_path / "missing")})
