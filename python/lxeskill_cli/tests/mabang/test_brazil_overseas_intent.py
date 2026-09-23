import json
from datetime import datetime, timezone

import pytest

from lxeskill.business import load_catalog
from lxeskill import cli as lxeskill_cli
from services.mabang.brazil_overseas.contracts import BrazilExportKind, DEFAULT_OUTPUT_DIR
from services.mabang.brazil_overseas.intent import BrazilIntentClarification, validate_brazil_export_parameters
from services.mabang.brazil_overseas.naming import output_filename
from shared.repository import repository_root


PROJECT_ROOT = repository_root()
EXPECTED_STATUS_PHRASES = {
    "allocation_pending_default_3m": ("未签", "未签收", "待签", "待签收", "还没签收", "尚未签收"),
    "allocation_signed_before_3m": ("已签", "已签收", "已经签收", "签收完成"),
}


def _brazil_skill_text() -> str:
    return (PROJECT_ROOT / "skills" / "replenishment-workflow-map" / "SKILL.md").read_text(
        encoding="utf-8",
    )


@pytest.mark.parametrize("kind", list(BrazilExportKind))
def test_validates_model_resolved_parameters(kind: BrazilExportKind) -> None:
    plan = validate_brazil_export_parameters(warehouse="brazil_overseas", export_kind=kind.value)

    assert plan.kind is kind
    assert plan.warehouse_id == "1072376"
    assert plan.warehouse_label == "巴西海外仓"
    assert plan.source_data_note == "平台原始库存文件仅含7/28/42天累计销量"


def test_rejects_non_brazil_warehouse() -> None:
    result = validate_brazil_export_parameters(warehouse="other", export_kind=BrazilExportKind.INVENTORY_SALES_SNAPSHOT.value)
    assert isinstance(result, BrazilIntentClarification)
    assert result.code == "brazil_warehouse_required"


def test_rejects_unknown_export_kind() -> None:
    result = validate_brazil_export_parameters(warehouse="brazil_overseas", export_kind="ambiguous")
    assert isinstance(result, BrazilIntentClarification)
    assert result.code == "brazil_export_kind_required"


@pytest.mark.parametrize(
    ("kind", "expected"),
    [
        (
            BrazilExportKind.INVENTORY_SALES_SNAPSHOT,
            "马帮系统-库存-巴西海外仓-2026-09-18_1430.xlsx",
        ),
        (
            BrazilExportKind.ALLOCATION_SIGNED_BEFORE_3M,
            "马帮系统-已签收-巴西海外仓-2026-09-18_1430.xlsx",
        ),
        (
            BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M,
            "马帮系统-3个月待签收-巴西海外仓-2026-09-18_1430.xlsx",
        ),
    ],
)
def test_output_filenames_use_beijing_time(kind: BrazilExportKind, expected: str) -> None:
    executed_at = datetime(2026, 9, 18, 6, 30, tzinfo=timezone.utc)

    assert output_filename(kind, executed_at=executed_at) == expected


def test_documents_without_status_use_the_existing_command_and_both_exports() -> None:
    plan = validate_brazil_export_parameters(
        warehouse="brazil_overseas",
        export_kind="allocation_both",
    )

    assert plan.kind is BrazilExportKind.ALLOCATION_BOTH


def test_brazil_status_synonyms_are_complete_and_identical_in_skill_and_catalog() -> None:
    skill = _brazil_skill_text()
    schema = load_catalog()["mabang_brazil_overseas_export"]["input_schema"]
    catalog_description = schema["properties"]["export_kind"]["description"]

    for export_kind, phrases in EXPECTED_STATUS_PHRASES.items():
        assert export_kind in skill
        assert export_kind in catalog_description
        for phrase in phrases:
            assert phrase in skill
            assert phrase in catalog_description

    assert "Brazil Overseas 上下文明确时，单据/调拨单据" in skill
    assert "Brazil Overseas 上下文明确时，单据/调拨单据" in catalog_description
    assert "调拨单据" in skill
    assert "调拨单据" in catalog_description
    assert schema == {
        "type": "object",
        "properties": {
            "warehouse": {
                "type": "string",
                "enum": ["brazil_overseas"],
                "description": "模型解析后的仓库参数，必须是巴西海外仓。",
            },
            "export_kind": {
                "type": "string",
                "enum": [kind.value for kind in BrazilExportKind],
                "description": catalog_description,
            },
        },
        "required": ["warehouse", "export_kind"],
        "additionalProperties": False,
    }


def test_brazil_skill_resolves_documents_and_only_clarifies_truly_ambiguous_terms() -> None:
    skill = _brazil_skill_text()

    assert "裸词“单据”" not in skill
    assert "clarification_required" in skill
    assert "Brazil Overseas 上下文明确时，单据/调拨单据 → `allocation_both`" in skill
    assert "仅“签收”或仅“调拨”" in skill


def test_brazil_skill_auth_recovery_is_explicit_and_bounded() -> None:
    skill = _brazil_skill_text()
    brazil_section = skill.split("## Brazil Overseas 子工作流", 1)[1].split("## 完整任务", 1)[0]

    assert "data.auth_refresh_required=true" in brazil_section
    assert "刷新一次" in brazil_section
    assert "仅重试当前失败步骤一次" in brazil_section
    assert "false 或缺失" in brazil_section
    assert "403、429、风控或导出状态不确定" in brazil_section
    assert "不得重复创建导出任务或重新启动下载" in brazil_section


def test_brazil_parameter_validator_documentation_excludes_prose_and_runtime_routing() -> None:
    documentation = validate_brazil_export_parameters.__doc__ or ""

    assert "selected Skill" in documentation
    assert "global Runtime filter" in documentation


@pytest.mark.parametrize(
    "arguments",
    [
        ["--warehouse", "other", "--export-kind", "inventory_sales_snapshot"],
        ["--warehouse", "brazil_overseas", "--export-kind", "not_an_export_kind"],
        [
            "--warehouse",
            "brazil_overseas",
            "--export-kind",
            "inventory_sales_snapshot",
            "--unexpected",
            "value",
        ],
    ],
)
def test_brazil_cli_rejects_non_contract_parameters_before_business_execution(arguments, capsys) -> None:
    exit_code = lxeskill_cli.main(["replenish", "brazil-overseas", "export", *arguments])
    (record,) = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line]

    assert exit_code == lxeskill_cli.EXIT_USAGE
    assert record["type"] == "result"
    assert record["ok"] is False
    assert record["files"] == []
    assert record["error"]["code"] == "invalid_arguments"


def test_brazil_exports_use_the_registered_replenishment_artifact_partition() -> None:
    assert DEFAULT_OUTPUT_DIR.as_posix().endswith("artifacts/replenish/brazil_overseas")
