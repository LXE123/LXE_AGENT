from pathlib import Path

from openpyxl import Workbook
import pytest

from services.vietnam_replenishment import settings, validation_diagnostics
from services.vietnam_replenishment.asset_contract import validate_usable_sku_parameters, SkuMapValidationError
from services.vietnam_replenishment.sku_map_store import SkuMapStoreError


def invalid_map(path: Path, rows: int) -> Path:
    book = Workbook()
    book.active.title = "SKU参数映射"
    book.active.append(["SKU", "热销标记", "成本", "跨境价", "折扣价"])
    for index in range(rows):
        book.active.append([f"VN-{index:03}", None, 0, 2, 3])
    book.save(path)
    book.close()
    return path


def test_short_diagnostic_contains_all_findings_without_report_file(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))
    with pytest.raises(SkuMapValidationError) as caught:
        validate_usable_sku_parameters(invalid_map(tmp_path / "invalid.xlsx", 2))
    message = validation_diagnostics.validation_diagnostic(caught.value)
    assert "4 个错误，涉及 2 行" in message
    for cell in ("B2", "C2", "B3", "C3"):
        assert f"SKU参数映射!{cell}" in message
    assert "完整错误报告" not in message
    assert not (tmp_path / "app").exists()


def test_long_diagnostic_keeps_every_finding_in_a_redacted_report(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "应用 数据"))
    monkeypatch.setenv("LXE_YACANG_PASSWORD", "VN-005")
    source = invalid_map(tmp_path / "中文 映射表.xlsx", 80)
    with pytest.raises(SkuMapStoreError) as caught:
        settings.upload_map(source)
    message = validation_diagnostics.validation_diagnostic(caught.value)
    assert "160 个错误，涉及 80 行" in message
    assert len(message) < 2000
    assert "部分错误" in message and "预览" in message
    [report] = (tmp_path / "应用 数据" / "tmp" / "sku-map-validation").glob("*.txt")
    assert str(report) in message
    text = report.read_text(encoding="utf-8")
    assert text.count("SKU参数映射!") == 160
    assert "SKU参数映射!C81" in text
    assert "VN-005" not in text + message
    assert str(source) in text
    assert not (settings.data_directory() / "sku-map.xlsx").exists()


def test_report_write_failure_preserves_validation_and_actual_io_diagnostic(tmp_path, monkeypatch):
    def denied(**_kwargs):
        raise PermissionError("fixture report permission denied")

    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))
    monkeypatch.setattr(validation_diagnostics, "NamedTemporaryFile", denied)
    with pytest.raises(SkuMapValidationError) as caught:
        validate_usable_sku_parameters(invalid_map(tmp_path / "invalid.xlsx", 80))
    message = validation_diagnostics.validation_diagnostic(caught.value)
    assert "160 个错误，涉及 80 行" in message
    assert "完整错误报告写入失败: PermissionError: fixture report permission denied" in message
    assert "部分错误" in message
    assert not list((tmp_path / "app" / "tmp" / "sku-map-validation").glob("*.txt"))


def test_non_validation_error_preserves_actual_cause_and_redaction(monkeypatch):
    monkeypatch.setenv("LXE_YACANG_PASSWORD", "private-password")
    message = validation_diagnostics.validation_diagnostic(OSError("actual failure private-password"))
    assert "OSError: actual failure" in message
    assert "private-password" not in message
