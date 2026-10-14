from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from importlib.resources import files
import json
from pathlib import Path
import subprocess
import sys

from openpyxl import load_workbook
import pytest

from services.vietnam_replenishment import settings, workflow
from services.vietnam_replenishment.full_workbook import UNCHANGED
from services.vietnam_replenishment.workbook import RecommendationConfig
from shared.input_assets import current_asset, previous_asset


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "app"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    from shared import workspace
    monkeypatch.setattr(workspace, "_workspace_root", tmp_path)
    monkeypatch.setattr(workspace, "_input_root", tmp_path / "app" / "inputs")


def nine_sheet_template(path: Path, *, marker: str = "first") -> Path:
    resource = files("services.vietnam_replenishment").joinpath("resources/skeleton.xlsx")
    with resource.open("rb") as stream:
        book = load_workbook(stream)
    try:
        book["越南备货清单"]["B2"] = 2
        book["越南备货清单"]["E2"] = "VN-A"
        book["越南备货清单"]["G2"] = 10
        for index, name in enumerate(UNCHANGED, 1):
            book.create_sheet(name, index)["A1"] = marker
        book.save(path)
    finally:
        book.close()
    return path


def test_nine_sheet_template_upload_export_and_invalid_replacement(tmp_path):
    source = nine_sheet_template(tmp_path / "完整九表.xlsx")
    state = settings.upload_template(source)
    assert state["template"]["file_name"] == source.name
    saved = current_asset("vietnam_full_workbook")
    assert saved is not None and saved.path.read_bytes() == source.read_bytes()
    exported = tmp_path / "导出当前模板.xlsx"
    assert settings.export_template(exported) == {"path": str(exported)}
    assert exported.read_bytes() == source.read_bytes()
    with pytest.raises(ValueError, match="不能覆盖"):
        settings.export_template(saved.path)
    assert saved.path.read_bytes() == source.read_bytes()

    invalid = tmp_path / "invalid.xlsx"
    invalid.write_bytes(b"not a workbook")
    with pytest.raises(ValueError):
        settings.upload_template(invalid)
    assert current_asset("vietnam_full_workbook").path.read_bytes() == source.read_bytes()

    replacement = nine_sheet_template(tmp_path / "新版九表.xlsx", marker="second")
    assert settings.upload_template(replacement)["template"]["file_name"] == replacement.name
    assert previous_asset("vietnam_full_workbook").path.read_bytes() == source.read_bytes()


def test_nine_sheet_template_export_requires_saved_version(tmp_path):
    with pytest.raises(ValueError, match="模板"):
        settings.export_template(tmp_path / "missing.xlsx")


def test_defaults_persist_and_reload_in_another_process():
    state = settings.read_state()
    assert state["parameters"] == settings.config_json(RecommendationConfig())
    assert "sku_map" not in state and "sku_map_error" not in state
    raw = {**state["parameters"], "exchange_rate": "4100", "sales_weight_7d": "1", "sales_weight_15d": "0", "sales_weight_30d": "0"}
    settings.save_parameters(raw)
    child = subprocess.run([sys.executable, "-I", "-B", "-m", "services.vietnam_replenishment.settings", "read"], capture_output=True, text=True)
    assert child.returncode == 0, child.stderr
    assert json.loads(child.stdout)["data"]["parameters"] == raw


@pytest.mark.parametrize("change", [
    {"sales_weight_7d": "0.5"}, {"sales_weight_7d": "-0.1"}, {"exchange_rate": "0"},
    {"day_adjustment_15d": "-1"}, {"day_adjustment_7d": "NaN"}, {"exchange_rate": "1e9999999999"},
    {"exchange_rate": "1e-9999"}, {"exchange_rate": "0.1234567890123456"}, {"sales_weight_7d": 0.6},
    {"extra": "1"},
])
def test_invalid_save_preserves_previous_file(change):
    old = settings.read_state()["parameters"]
    file = settings.data_directory() / "parameters.json"
    before = file.read_bytes()
    with pytest.raises((ValueError, ArithmeticError)):
        settings.save_parameters({**old, **change})
    assert file.read_bytes() == before


def test_corrupt_existing_configuration_is_reported_not_reset():
    settings.read_state()
    file = settings.data_directory() / "parameters.json"
    file.write_text("{broken")
    state = settings.read_state()
    assert "JSONDecodeError" in state["parameters_error"]
    assert state["parameters"] is None
    assert file.read_text() == "{broken"


def test_config_snapshot_is_stable_during_run(tmp_path):
    with settings.run_inputs() as (config, source):
        assert source == str(settings.data_directory() / "parameters.json")
        settings.save_parameters(settings.config_json(replace(config, exchange_rate=Decimal(4200))))
        assert config.exchange_rate == Decimal(3900)
    with settings.run_inputs() as (updated, _):
        assert updated.exchange_rate == Decimal(4200)


def test_invalid_configuration_stops_before_reports(tmp_path, monkeypatch):
    template = nine_sheet_template(tmp_path / "template.xlsx")
    settings.read_state()
    path = settings.data_directory() / "parameters.json"
    path.write_text('{"exchange_rate":"0"}')
    monkeypatch.setattr(workflow, "load_vietnam_files", lambda **_paths: pytest.fail("Source loading must not run"))
    with pytest.raises(ValueError):
        workflow.generate_current_vietnam_recommendation(
            sales="sales.xlsx", inventory="inventory.xlsx", products="products.xlsx", template=str(template),
        )


@pytest.mark.parametrize("old_parameters", ["{broken", json.dumps({"vietnam_recommendation": {"exchange_rate": "4200"}})])
def test_initialization_uses_only_skill_data_directory(tmp_path, old_parameters):
    app = tmp_path / "app"
    (app / "config").mkdir(parents=True)
    (app / "config" / "settings.json").write_text(old_parameters)
    state = settings.read_state()
    assert state["parameters"] == settings.config_json(RecommendationConfig())
    assert state["parameters_error"] is None
    assert "sku_map" not in state and "sku_map_error" not in state
    assert (app / "config" / "settings.json").read_text() == old_parameters
