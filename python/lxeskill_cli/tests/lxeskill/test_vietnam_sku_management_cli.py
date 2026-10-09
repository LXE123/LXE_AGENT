"""The Desktop management commands are fixed-slot, internal, and factual."""

from __future__ import annotations

import json
from pathlib import Path

from openpyxl import Workbook
import pytest

from lxeskill import cli as lxeskill
from lxeskill.business import load_catalog
from services.assets import vietnam_sku_install, vietnam_sku_rollback


def _map(path: Path, price: int) -> Path:
    book = Workbook()
    book.active.append(("SKU", "成本", "跨境价", "折扣价", "热销标记"))
    book.active.append(("VN-A", 0, price, 15, None))
    book.save(path)
    book.close()
    return path


def _record(capsys) -> dict:
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(lines) == 1
    return json.loads(lines[0])


def test_catalog_has_two_unexposed_fixed_slot_commands() -> None:
    catalog = load_catalog()
    for name, command in (
        ("assets_vietnam_sku_install", ["assets", "vietnam", "sku", "install"]),
        ("assets_vietnam_sku_rollback", ["assets", "vietnam", "sku", "rollback"]),
    ):
        entry = catalog[name]
        assert entry["command_path"] == command
        assert entry["visibility"] == "internal"
        assert entry["exposed"] is False
        assert entry["session_mode"] == "none"
        assert entry["input_schema"]["additionalProperties"] is False
        assert "slot" not in entry["input_schema"]["properties"]


def test_invalid_arguments_rejected_before_access(tmp_path: Path) -> None:
    assert vietnam_sku_install.run({
        "source_path": str(tmp_path / "a.xlsx"),
        "expected_revision": "",
        "slot": "other",
    })["error"]["code"] == "invalid_arguments"
    assert vietnam_sku_install.run({
        "source_path": "relative.xlsx", "expected_revision": "",
    })["error"]["code"] == "invalid_arguments"
    assert vietnam_sku_install.run({
        "source_path": str(tmp_path / "a.xlsx"), "expected_revision": "../bad",
    })["error"]["code"] == "invalid_arguments"
    assert vietnam_sku_rollback.run({"expected_revision": ""})["error"]["code"] == "invalid_arguments"


def test_cli_install_replace_and_rollback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys,
) -> None:
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    first_path = _map(tmp_path / "first.xlsx", 20)
    second_path = _map(tmp_path / "second.xlsx", 30)
    assert lxeskill.main([
        "assets", "vietnam", "sku", "install",
        "--source-path", str(first_path), "--expected-revision", "",
    ]) == 0
    first = _record(capsys)
    assert first["ok"] is True
    assert first["data"]["status"] == "installed"
    first_revision = first["data"]["manifest_revision"]
    assert len(first_revision) == 32

    assert lxeskill.main([
        "assets", "vietnam", "sku", "install",
        "--source-path", str(second_path), "--expected-revision", first_revision,
    ]) == 0
    second = _record(capsys)
    second_revision = second["data"]["manifest_revision"]
    assert second_revision != first_revision

    assert lxeskill.main([
        "assets", "vietnam", "sku", "rollback", "--expected-revision", second_revision,
    ]) == 0
    rolled = _record(capsys)
    assert rolled["data"]["status"] == "rolled_back"
    assert rolled["data"]["manifest_revision"] not in (first_revision, second_revision)
    assert rolled["files"] == []


def test_cli_reports_actual_validation_error_and_rejects_extra_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys,
) -> None:
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    bad = tmp_path / "bad.xlsx"
    bad.write_bytes(b"not xlsx")
    assert lxeskill.main([
        "assets", "vietnam", "sku", "install",
        "--source-path", str(bad), "--expected-revision", "",
    ]) == lxeskill.EXIT_BUSINESS
    result = _record(capsys)
    assert result["ok"] is False
    assert "BadZipFile" in result["error"]["message"]
    assert result["files"] == []

    assert lxeskill.main([
        "assets", "vietnam", "sku", "install",
        "--source-path", str(bad), "--expected-revision", "", "--slot", "other",
    ]) == lxeskill.EXIT_USAGE
    usage = _record(capsys)
    assert usage["ok"] is False
    assert "unknown option" in usage["error"]["message"]
