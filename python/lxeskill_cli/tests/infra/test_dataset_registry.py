"""Artifact dataset registry contracts.

``catalog.json`` -> ``datasets`` is the single source of truth for where CLI
output lands. These tests check dataset paths and workspace isolation.
"""
from __future__ import annotations

import pytest

from shared.datasets import load_datasets

DATASETS = load_datasets()


def test_workspace_datasets_share_only_within_selected_workspace(tmp_path, monkeypatch) -> None:
    from shared import workspace
    from shared.datasets import dataset_dir
    from lxeskill.business import ArtifactPathError, allowed_output_file

    data_root = tmp_path / "var"
    old = data_root / "artifacts" / "mabang_fba_delivery" / "SP1.csv"
    old.parent.mkdir(parents=True)
    old.write_text("legacy", encoding="utf-8")
    first, second = tmp_path / "first", tmp_path / "second"
    dataset_id = next(iter(DATASETS))
    try:
        monkeypatch.setenv("LXE_DATA_ROOT", str(data_root))
        monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(first))
        workspace.activate_project_workspace()
        output = dataset_dir(dataset_id) / "shared.csv"
        output.parent.mkdir(parents=True)
        output.write_text("current", encoding="utf-8")
        assert allowed_output_file(str(output)) == output.resolve()
        workspace.activate_project_workspace()  # another CLI call in the same workspace
        assert (dataset_dir(dataset_id) / "shared.csv").read_text() == "current"
        monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(second))
        workspace.activate_project_workspace()
        assert dataset_dir(dataset_id) == second / ".lxeagent" / "artifacts" / DATASETS[dataset_id].dir
        assert not (dataset_dir(dataset_id) / "shared.csv").exists()
        with pytest.raises(ArtifactPathError):
            allowed_output_file(str(output))
        with pytest.raises(ArtifactPathError):
            allowed_output_file(str(old))
        assert list(old.parent.iterdir()) == [old]
        assert old.read_text() == "legacy"
        assert not (data_root / "artifacts" / "fba").exists()
    finally:
        monkeypatch.undo()
        workspace.activate_project_workspace()


def test_standalone_cli_uses_cwd_and_keeps_app_state_separate(tmp_path, monkeypatch) -> None:
    from shared import workspace
    caller = tmp_path / "caller"
    caller.mkdir()
    try:
        monkeypatch.delenv("LXE_WORKSPACE_ROOT", raising=False)
        monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
        monkeypatch.chdir(caller)
        workspace.activate_project_workspace()
        assert workspace.artifact_root() == caller / ".lxeagent" / "artifacts"
        assert workspace.internal_root() == tmp_path / "state" / "lxeskill"
        assert workspace.input_root() == tmp_path / "state" / "inputs"
    finally:
        monkeypatch.undo()
        workspace.activate_project_workspace()
