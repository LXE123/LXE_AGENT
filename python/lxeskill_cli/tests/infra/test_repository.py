from __future__ import annotations

from pathlib import Path

from shared.repository import find_repository_root, repository_root, runtime_env_path, skills_root, state_root


def _write_repository_markers(root: Path) -> None:
    (root / "config").mkdir(parents=True)
    (root / "skills").mkdir()
    (root / "package.json").write_text("{}\n", encoding="utf-8")
    (root / "pyproject.toml").write_text("[project]\n", encoding="utf-8")


def test_legacy_lxe_root_does_not_redirect_source_discovery(tmp_path: Path) -> None:
    root = tmp_path / "安装目录 中文"
    _write_repository_markers(root)

    assert find_repository_root(root, environment={"LXE_ROOT": str(tmp_path / "missing")}) == root


def test_explicit_owned_resource_paths_do_not_require_repository_markers(tmp_path: Path) -> None:
    skill_directory = tmp_path / "resources" / "skills"
    runtime_config = tmp_path / "resources" / "config" / "runtime.env"

    assert skills_root(environment={"LXE_SKILLS_ROOT": str(skill_directory)}) == skill_directory.resolve()
    assert runtime_env_path(environment={"LXE_RUNTIME_ENV_PATH": str(runtime_config)}) == runtime_config.resolve()


def test_state_root_separates_writable_desktop_data_from_assets(tmp_path: Path) -> None:
    writable = tmp_path / "桌面数据"

    assert state_root(environment={"LXE_DATA_ROOT": str(writable)}) == writable.resolve()
    assert state_root(environment={}) == (repository_root() / "var").resolve()
