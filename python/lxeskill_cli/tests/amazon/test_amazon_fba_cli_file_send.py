from __future__ import annotations

from pathlib import Path

from services.agent_cli.browser.amazon_fba import _shared as fba_shared
from shared.repository import repository_root


def _payload(file_path: list[dict[str, str]], *, notice: str = "base notice") -> dict:
    return {
        "params_ready": True,
        "finished": True,
        "exception": "",
        "notice": notice,
        "file_path": file_path,
        "context": {"consignment_no": "SP260516028"},
    }


def _configure_archive_root(monkeypatch, tmp_path: Path) -> Path:
    project_root = tmp_path / "workspace"
    attachments_root = project_root / "artifacts" / "amazon_fba" / "attachments"
    project_root.mkdir()
    monkeypatch.setattr(fba_shared, "_ATTACHMENTS_ROOT", attachments_root)
    monkeypatch.setattr(fba_shared, "workspace_root", lambda: project_root)
    return project_root


def test_archive_selected_result_files_copies_allowed_files_to_artifacts(monkeypatch, tmp_path: Path):
    project_root = _configure_archive_root(monkeypatch, tmp_path)
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    consignment = source_dir / "consignment.xlsx"
    filled = source_dir / "filled.xlsx"
    ignored = source_dir / "template.xlsx"
    consignment.write_bytes(b"consignment")
    filled.write_bytes(b"filled")
    ignored.write_bytes(b"ignored")
    entries = [
        {"key": "consignment_excel", "value": str(consignment)},
        {"key": "amazon_template", "value": str(ignored)},
        {"key": "filled_template", "value": str(filled)},
    ]

    result = fba_shared.archive_selected_result_files(
        _payload(entries, notice="ok"),
        allowed_keys=("consignment_excel", "filled_template"),
        stage="prepare_upload",
    )

    assert result["notice"] == "ok"
    assert result["file_path"] == [
        {
            "key": "consignment_excel",
            "value": "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/"
            "SP260516028_consignment.xlsx",
        },
        {
            "key": "filled_template",
            "value": "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/"
            "SP260516028_upload.xlsx",
        },
    ]
    assert (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/"
        "SP260516028_consignment.xlsx"
    ).read_bytes() == b"consignment"
    assert (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/SP260516028_upload.xlsx"
    ).read_bytes() == b"filled"
    assert not (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/amazon_template_template.xlsx"
    ).exists()


def test_archive_selected_result_files_works_without_agent_session(monkeypatch, tmp_path: Path):
    project_root = _configure_archive_root(monkeypatch, tmp_path)
    source = tmp_path / "filled.xlsx"
    source.write_bytes(b"filled")
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)

    result = fba_shared.archive_selected_result_files(
        _payload([{"key": "filled_template", "value": str(source)}]),
        allowed_keys=("filled_template",),
        stage="prepare_upload",
    )

    assert result["file_path"] == [
        {
            "key": "filled_template",
            "value": "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/"
            "SP260516028_upload.xlsx",
        }
    ]
    assert (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/SP260516028_upload.xlsx"
    ).read_bytes() == b"filled"
    assert result["notice"] == "base notice"


def test_archive_selected_result_files_records_missing_source_without_runtime_emit(
    monkeypatch,
    tmp_path: Path,
):
    _configure_archive_root(monkeypatch, tmp_path)
    missing = tmp_path / "missing.xlsx"

    result = fba_shared.archive_selected_result_files(
        _payload([{"key": "filled_template", "value": str(missing)}]),
        allowed_keys=("filled_template",),
        stage="prepare_upload",
    )

    assert result["file_path"] == [{"key": "filled_template", "value": str(missing)}]
    assert "base notice" in result["notice"]
    assert "文件已生成记录存在，但归档附件失败" in result["notice"]
    assert "file path missing" in result["notice"]
    assert "runtime emit handler not configured" not in result["notice"]
    assert "发送到群里失败" not in result["notice"]


def test_archive_selected_result_files_uses_short_step2_file_name(monkeypatch, tmp_path: Path):
    project_root = _configure_archive_root(monkeypatch, tmp_path)
    source = tmp_path / "2026-07-08_10-22-51_edf8e216-a569-48e0-9a78-3a321f525f1c.filled.xlsx"
    source.write_bytes(b"step2")

    result = fba_shared.archive_selected_result_files(
        _payload([{"key": "step2_filled", "value": str(source)}]),
        allowed_keys=("step2_filled",),
        stage="prepare_multi_box_excel",
    )

    assert result["file_path"] == [
        {
            "key": "step2_filled",
            "value": "artifacts/amazon_fba/attachments/SP260516028/prepare_multi_box_excel/"
            "SP260516028_multi_box.xlsx",
        }
    ]
    assert (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/prepare_multi_box_excel/SP260516028_multi_box.xlsx"
    ).read_bytes() == b"step2"


def test_archive_selected_result_files_keeps_safe_fallback_for_unknown_allowed_key(monkeypatch, tmp_path: Path):
    project_root = _configure_archive_root(monkeypatch, tmp_path)
    source = tmp_path / "note.txt"
    source.write_bytes(b"note")

    result = fba_shared.archive_selected_result_files(
        _payload([{"key": "future_report", "value": str(source)}]),
        allowed_keys=("future_report",),
        stage="future_stage",
    )

    assert result["file_path"] == [
        {
            "key": "future_report",
            "value": "artifacts/amazon_fba/attachments/SP260516028/future_stage/future_report_note.txt",
        }
    ]
    assert (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/future_stage/future_report_note.txt"
    ).read_bytes() == b"note"


def test_fba_shipment_create_skill_requires_parent_send_files():
    skill_path = repository_root() / "skills" / "fba-shipment-create" / "SKILL.md"
    text = skill_path.read_text(encoding="utf-8")

    assert "terminal `files` 非空" in text
    assert "send_files(paths=<terminal.files>)" in text
    assert "不重跑 CLI" in text


def test_all_four_fba_shipment_stages_declare_the_same_deliverable_selector():
    catalog = __import__("lxeskill.business", fromlist=["load_catalog"]).load_catalog()
    stage_names = {
        "amazon_fba_prepare_upload",
        "amazon_fba_prepare_multi_box_excel",
        "amazon_fba_confirm_own_carrier",
        "amazon_fba_enter_tracking_codes",
    }

    assert {
        name: catalog[name]["artifact_paths"]
        for name in stage_names
    } == {
        name: [{"field": "file_path[].value", "role": "deliverable"}]
        for name in stage_names
    }
