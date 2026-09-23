import os
from pathlib import Path

import pytest

from lxeskill import business
from shared.filesystem import display_path, filesystem_path


def test_long_file_delivery_keeps_display_path_and_root_boundary(tmp_path, monkeypatch):
    root = tmp_path / ("导出 目录" * 16) / ("nested" * 12)
    inside = root / "报告.xlsx"
    outside = tmp_path / "outside.xlsx"
    filesystem_path(root).mkdir(parents=True)
    filesystem_path(inside).write_bytes(b"report")
    outside.write_bytes(b"outside")
    assert len(str(inside)) > 260
    monkeypatch.setattr(business, "artifact_root", lambda: root)
    resolved = business.allowed_output_file(str(inside))
    assert not str(resolved).startswith("\\\\?\\")
    assert filesystem_path(resolved).read_bytes() == b"report"
    assert business.allowed_output_file(str(filesystem_path(inside))) == resolved
    with pytest.raises(business.ArtifactPathError, match="outside allowed"):
        business.allowed_output_file(str(filesystem_path(outside)))
    with pytest.raises(business.ArtifactPathError, match="missing file"):
        business.allowed_output_file(str(root / "missing.xlsx"))


@pytest.mark.skipif(os.name != "nt", reason="Windows extended path syntax")
@pytest.mark.parametrize("raw", [
    "C:\\导出 目录\\report.xlsx",
    "\\\\server\\share\\导出 目录\\report.xlsx",
])
def test_windows_drive_and_unc_paths_round_trip(raw):
    path = filesystem_path(raw)
    assert str(path).startswith("\\\\?\\")
    assert filesystem_path(path) == path
    assert display_path(path) == Path(raw)


def test_relative_path_normalized_before_filesystem_access(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "inner").mkdir()
    (tmp_path / "report.xlsx").write_bytes(b"report")
    path = filesystem_path(Path("inner") / ".." / "report.xlsx")
    assert path.read_bytes() == b"report"
