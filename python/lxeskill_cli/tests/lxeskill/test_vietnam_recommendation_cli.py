from __future__ import annotations

import io
import json
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import pytest

from lxeskill import cli as lxeskill
from lxeskill.business import load_catalog
from services.agent_cli.vietnam_replenishment import generate
from services.vietnam_replenishment.workbook import RecommendationConfig


COMMAND = ["vietnam", "stock", "recommend"]


def _record(capsys) -> dict:
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert len(lines) == 1
    return json.loads(lines[0])


def _no_workflow(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected() -> None:
        raise AssertionError("workflow must not run")

    monkeypatch.setattr(generate, "generate_current_vietnam_recommendation", unexpected)


def test_catalog_exposes_no_input_or_asset_override() -> None:
    entry = load_catalog()["vietnam_replenishment_generate"]
    assert entry["module"] == "services.agent_cli.vietnam_replenishment.generate"
    assert entry["command_path"] == COMMAND
    assert entry["session_mode"] == "none"
    assert entry["owner_skills"] == ["vietnam-stock-recommendation"]
    assert entry["input_schema"] == {"type": "object", "properties": {}, "additionalProperties": False}
    assert entry["artifact_paths"] == [{"field": "output_xlsx", "role": "deliverable"}]
    assert entry.get("deliver_artifacts_on_failure") is not True


@pytest.mark.parametrize("arguments", [{"map_path": "/tmp/other.xlsx"}, {"cost_rate": 0.7}])
def test_adapter_rejects_all_arguments_before_workflow(arguments: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    _no_workflow(monkeypatch)
    result = generate.run(arguments)
    assert result["success"] is False
    assert result["error"]["code"] == "invalid_arguments"
    assert "output_xlsx" not in result


@pytest.mark.parametrize("mode", ["stdin", "file"])
def test_json_input_cannot_override_current_map(
    mode: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    _no_workflow(monkeypatch)
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    input_json = '{"map_path":"/tmp/other.xlsx"}'
    if mode == "stdin":
        monkeypatch.setattr("sys.stdin", io.StringIO(input_json))
        args = [*COMMAND, "--stdin-json"]
    else:
        source = tmp_path / "input.json"
        source.write_text(input_json, encoding="utf-8")
        args = [*COMMAND, "--input-json", str(source)]

    assert lxeskill.main(args) == lxeskill.EXIT_BUSINESS
    record = _record(capsys)
    assert record["ok"] is False
    assert record["data"]["error"]["code"] == "invalid_arguments"
    assert record["files"] == []


def test_success_delivers_only_final_workbook(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    workspace = tmp_path / "workspace"
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(workspace))
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    output = workspace / ".lxeagent" / "artifacts" / "vietnam" / "recommendations" / "run" / "越南备货清单.xlsx"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"synthetic workbook")
    monkeypatch.setattr(
        generate,
        "generate_current_vietnam_recommendation",
        lambda: SimpleNamespace(
            output_xlsx=output, sku_count=2,
            config=RecommendationConfig(
                weight_30d=Decimal("0.7"), weight_15d=Decimal("0.6"),
                weight_7d=Decimal("0.1"), exchange_rate=Decimal("4000"),
            ),
            config_source="environment",
        ),
    )

    assert lxeskill.main(COMMAND) == 0
    record = _record(capsys)
    assert record["ok"] is True
    assert record["files"] == [str(output)]
    assert record["data"] == {
        "success": True,
        "status": "completed",
        "warehouse": "VN8806",
        "sku_count": 2,
        "output_xlsx": str(output),
        "config": {
            "weight_30d": "0.7", "weight_15d": "0.6",
            "weight_7d": "0.1", "exchange_rate": "4000",
        },
        "config_source": "environment",
    }


def test_business_failure_preserves_real_redacted_diagnostic_and_delivers_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    class ObservedFailure(RuntimeError):
        code = "sku_parameter_map_required"

    def fail() -> None:
        raise ObservedFailure("请先上传越南 SKU 参数映射表: password=topsecret")

    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_YACANG_PASSWORD", "topsecret")
    monkeypatch.setattr(generate, "generate_current_vietnam_recommendation", fail)

    assert lxeskill.main(COMMAND) == lxeskill.EXIT_BUSINESS
    record = _record(capsys)
    assert record["ok"] is False
    assert record["files"] == []
    assert record["data"]["error"]["code"] == "sku_parameter_map_required"
    assert "ObservedFailure" in record["error"]["message"]
    assert "请先上传" in record["error"]["message"]
    assert "topsecret" not in record["error"]["message"]
    assert "output_xlsx" not in record["data"]


def test_missing_generated_file_fails_without_deliverable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    output = tmp_path / "state" / "artifacts" / "vietnam" / "recommendations" / "missing.xlsx"
    monkeypatch.setattr(
        generate,
        "generate_current_vietnam_recommendation",
        lambda: SimpleNamespace(output_xlsx=output, sku_count=2),
    )

    assert lxeskill.main(COMMAND) == lxeskill.EXIT_BUSINESS
    record = _record(capsys)
    assert record["ok"] is False
    assert record["files"] == []
    assert "FileNotFoundError" in record["error"]["message"]
