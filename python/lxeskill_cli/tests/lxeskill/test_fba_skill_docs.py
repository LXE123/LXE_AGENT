from __future__ import annotations

import yaml

from lxeskill.business import load_catalog
from shared.repository import repository_root


PROJECT_ROOT = repository_root()


def _skill_text(name: str) -> str:
    return (PROJECT_ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")


def test_repository_skill_inventory_distinguishes_top_level_and_nested_manifests() -> None:
    skill_root = PROJECT_ROOT / "skills"
    assert len(list(skill_root.glob("*/SKILL.md"))) == 30
    assert len(list(skill_root.rglob("SKILL.md"))) == 57
    assert not (skill_root / "feishu-im-read" / "SKILL.md").exists()
    assert (skill_root / "larksuite-cli" / "lark-im" / "SKILL.md").exists()


def test_yacang_has_one_discoverable_skill_and_one_natural_language_command() -> None:
    catalog = load_catalog()
    manifests = []
    for path in (PROJECT_ROOT / "skills").rglob("SKILL.md"):
        frontmatter = path.read_text(encoding="utf-8").split("---", 2)[1]
        metadata = yaml.safe_load(frontmatter) or {}
        if metadata.get("name", "").startswith("yacang-"):
            manifests.append((metadata["name"], metadata.get("type"), path))

    assert [(name, skill_type, path.parent.name) for name, skill_type, path in manifests] == [
        ("yacang-export-workflow-map", "amazon_replenish", "yacang-export-workflow-map")
    ]

    router = _skill_text("yacang-export-workflow-map")
    workflow = catalog["yacang_export_workflow"]
    assert workflow["command_path"] == ["yacang", "export", "run"]
    assert workflow["owner_skills"] == ["yacang-export-workflow-map"]
    assert workflow["exposed"] is True
    assert workflow["input_schema"]["required"] == ["request_text"]
    assert set(workflow["input_schema"]["properties"]) == {
        "request_text",
        "data_type_intent",
        "warehouse_intent",
        "created_date_filter",
        "inventory_snapshot_intent",
    }
    assert workflow["input_schema"]["additionalProperties"] is False
    assert workflow["input_schema"]["properties"]["data_type_intent"]["oneOf"]
    data_type_values = workflow["input_schema"]["properties"]["data_type_intent"]["oneOf"][2][
        "properties"
    ]["values"]["items"]["enum"]
    assert data_type_values[0] == "inventory-sales"
    assert {"sales-monthly", "sales-90d"}.issubset(data_type_values)
    assert workflow["input_schema"]["properties"]["warehouse_intent"]["oneOf"]
    assert workflow["input_schema"]["properties"]["created_date_filter"]["oneOf"]
    assert workflow["input_schema"]["properties"]["inventory_snapshot_intent"] == {
        "type": "object",
        "properties": {"state": {"enum": ["current", "historical", "omitted", "ambiguous"]}},
        "required": ["state"],
        "additionalProperties": False,
    }
    assert workflow["artifact_paths"] == [{"field": "artifacts[].path", "role": "deliverable"}]
    assert workflow["deliver_artifacts_on_failure"] is True
    assert "lxeskill yacang export run" in router.split("---", 2)[1]
    assert "needs_clarification" in router
    assert "模型不得计算日期" in router
    assert "禁止自行尝试相似 endpoint" in router
    assert "不得改走其他雅仓命令冒充成功" in router

    compatibility_entries = [
        catalog["yacang_export_inventory_sales"],
        catalog["yacang_export_sales_monthly"],
        catalog["yacang_export_sales_90d"],
        catalog["yacang_export_inventory_month_end"],
        catalog["yacang_export_inbound_listing_time"],
    ]
    assert all(entry["visibility"] == "internal" for entry in compatibility_entries)
    assert all(entry["owner_skills"] == [] for entry in compatibility_entries)
    assert all(entry["exposed"] is False for entry in compatibility_entries)


def test_ziniao_is_independent_and_shipment_owns_only_four_stages() -> None:
    catalog = load_catalog()
    assert catalog["ziniao_browser"]["owner_skills"] == ["ziniao-browser"]
    assert catalog["ziniao_page"]["owner_skills"] == ["ziniao-browser"]

    shipment = _skill_text("fba-shipment-create")
    frontmatter = shipment.split("---", 2)[1]
    assert "lxeskill browser" not in frontmatter
    assert frontmatter.count("lxeskill fba shipment") == 4

    ziniao = _skill_text("ziniao-browser")
    assert "data.screenshot_path" in ziniao
    assert "不含 base64" in ziniao
    assert "旧元素 `ref` 立即视为失效" in ziniao


def test_fba_docs_send_only_declared_deliverables() -> None:
    catalog = load_catalog()
    deliverable_owners = {
        str(owner)
        for entry in catalog.values()
        if list(entry.get("command_path") or [])[:1] == ["fba"]
        and any(item.get("role") == "deliverable" for item in list(entry.get("artifact_paths") or []))
        for owner in list(entry.get("owner_skills") or [])
    }
    assert deliverable_owners
    for owner in deliverable_owners:
        text = _skill_text(owner)
        assert "terminal `files`" in text, owner
        assert "send_files(paths=<terminal.files>)" in text, owner

    assert "不主动调用 `send_files`" in _skill_text("fba-export-tax-products-manage")


def test_purchase_confirmation_skill_distinguishes_proposed_and_current_inventory() -> None:
    text = _skill_text("fba-purchase-summary-create")

    for field in (
        "proposed_inventory_deduction_quantity",
        "proposed_purchase_quantity",
        "carryover_entry_id",
        "source_sp_no",
        "current_remaining_quantity",
        "replacement_released_quantity",
        "available_after_release",
        "proposed_applied_quantity",
    ):
        assert field in text
    assert "以上为待确认方案，当前库存尚未发生变化。" in text
    assert "禁止仅按合同号合并" in text
    assert "禁止用“ERP 原始数据”" in text


def test_purchase_skill_exposes_only_explicit_no_deduction_route() -> None:
    catalog = load_catalog()
    schema = catalog["mabang_generate_purchase_batch_workbooks"]["input_schema"]
    deduction_mode = schema["properties"]["inventory_deduction_mode"]

    assert deduction_mode["enum"] == ["none"]
    assert "inventory_deduction_mode" not in schema["required"]
    text = _skill_text("fba-purchase-summary-create")
    assert "--inventory-deduction-mode none" in text
    assert "普通采购必须省略" in text
    assert "不得根据库存量、金额或上下文自行推断" in text
