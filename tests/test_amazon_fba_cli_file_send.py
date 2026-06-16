from __future__ import annotations

from pathlib import Path

from agent_runtime.emit_bus import reset_emit_handlers
from services.agent_cli.browser.amazon_fba import _shared as fba_shared


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
    monkeypatch.setattr(fba_shared, "_PROJECT_ROOT", project_root)
    monkeypatch.setattr(fba_shared, "_ATTACHMENTS_ROOT", attachments_root)
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
            "consignment_excel_consignment.xlsx",
        },
        {
            "key": "filled_template",
            "value": "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/"
            "filled_template_filled.xlsx",
        },
    ]
    assert (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/"
        "consignment_excel_consignment.xlsx"
    ).read_bytes() == b"consignment"
    assert (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/filled_template_filled.xlsx"
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
    monkeypatch.delenv("LXE_RESPONSE_ROUTE_ID", raising=False)

    result = fba_shared.archive_selected_result_files(
        _payload([{"key": "filled_template", "value": str(source)}]),
        allowed_keys=("filled_template",),
        stage="prepare_upload",
    )

    assert result["file_path"] == [
        {
            "key": "filled_template",
            "value": "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/"
            "filled_template_filled.xlsx",
        }
    ]
    assert (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/prepare_upload/filled_template_filled.xlsx"
    ).read_bytes() == b"filled"
    assert result["notice"] == "base notice"


def test_archive_selected_result_files_records_missing_source_without_runtime_emit(
    monkeypatch,
    tmp_path: Path,
):
    _configure_archive_root(monkeypatch, tmp_path)
    missing = tmp_path / "missing.xlsx"

    reset_emit_handlers()
    result = fba_shared.archive_selected_result_files(
        _payload([{"key": "filled_template", "value": str(missing)}]),
        allowed_keys=("filled_template",),
        stage="prepare_upload",
    )

    assert result["file_path"] == []
    assert "base notice" in result["notice"]
    assert "文件已生成记录存在，但归档附件失败" in result["notice"]
    assert "file path missing" in result["notice"]
    assert "runtime emit handler not configured" not in result["notice"]
    assert "发送到群里失败" not in result["notice"]


def test_send_selected_result_files_compat_wrapper_archives_instead_of_emitting(
    monkeypatch,
    tmp_path: Path,
):
    project_root = _configure_archive_root(monkeypatch, tmp_path)
    source = tmp_path / "summary.xlsx"
    source.write_bytes(b"summary")

    reset_emit_handlers()
    result = fba_shared.send_selected_result_files(
        _payload([{"key": "shipment_summary_excel", "value": str(source)}]),
        allowed_keys=("shipment_summary_excel",),
        stage="confirm_own_carrier",
    )

    assert result["file_path"] == [
        {
            "key": "shipment_summary_excel",
            "value": "artifacts/amazon_fba/attachments/SP260516028/confirm_own_carrier/"
            "shipment_summary_excel_summary.xlsx",
        }
    ]
    assert (
        project_root
        / "artifacts/amazon_fba/attachments/SP260516028/confirm_own_carrier/"
        "shipment_summary_excel_summary.xlsx"
    ).read_bytes() == b"summary"
    assert "runtime emit handler not configured" not in result["notice"]


def test_fba_shipment_create_skill_requires_parent_send_file():
    skill_path = Path(__file__).resolve().parents[1] / "skills" / "fba-shipment-create" / "SKILL.md"
    text = skill_path.read_text(encoding="utf-8")

    assert "如果 `file_path` 非空" in text
    assert "send_file" in text
    assert "不重跑 CLI" in text
