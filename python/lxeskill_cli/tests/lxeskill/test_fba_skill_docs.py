from __future__ import annotations

import yaml

from lxeskill.business import load_catalog
from shared.repository import repository_root


PROJECT_ROOT = repository_root()


def _skill_text(name: str) -> str:
    return (PROJECT_ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")


def test_repository_skill_inventory_distinguishes_top_level_and_nested_manifests() -> None:
    skill_root = PROJECT_ROOT / "skills"
    assert len(list(skill_root.glob("*/SKILL.md"))) == 34
    assert len(list(skill_root.rglob("SKILL.md"))) == 61
    assert not (skill_root / "feishu-im-read" / "SKILL.md").exists()
    assert (skill_root / "larksuite-cli" / "lark-im" / "SKILL.md").exists()


def test_shangman_goods_export_is_the_single_owner_with_formal_permission_domain() -> None:
    text = _skill_text("shangman-goods-export-workflow-map")
    frontmatter = text.split("---", 2)[1]

    assert "name: shangman-goods-export-workflow-map" in frontmatter
    assert "type: replenishment" in frontmatter
    assert frontmatter.count("lxeskill shangman export") == 2
    assert "params" in text
    assert 'platform: "上马印尼"' in text
    assert 'country: "印尼"' in text
    assert "--params" in text
    assert "只明确说“上马”" in text
    assert "智慧" not in text
    assert "直接调用 `run`" in text
    assert "当前轮" in text


def test_yacang_has_one_discoverable_skill_and_one_natural_language_command() -> None:
    catalog = load_catalog()
    manifests = []
    for path in (PROJECT_ROOT / "skills").rglob("SKILL.md"):
        frontmatter = path.read_text(encoding="utf-8").split("---", 2)[1]
        metadata = yaml.safe_load(frontmatter) or {}
        if metadata.get("name", "").startswith("yacang-"):
            manifests.append((metadata["name"], metadata.get("type"), path))

    assert [(name, skill_type, path.parent.name) for name, skill_type, path in manifests] == [
        ("yacang-export-workflow-map", "replenishment", "yacang-export-workflow-map")
    ]

    router = _skill_text("yacang-export-workflow-map")
    workflow = catalog["yacang_export_workflow"]
    assert workflow["command_path"] == ["yacang", "export", "run"]
    assert workflow["owner_skills"] == ["yacang-export-workflow-map"]
    assert workflow["exposed"] is True
    assert workflow["input_schema"]["required"] == [
        "data_type_intent",
        "warehouse_intent",
        "created_date_filter",
        "inventory_snapshot_intent",
    ]
    assert set(workflow["input_schema"]["properties"]) == {
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
    assert data_type_values == [
        "inventory-sales",
        "inventory-current-snapshot",
        "inbound-listing-time",
    ]
    assert workflow["input_schema"]["properties"]["warehouse_intent"]["oneOf"]
    data_type_resolved = workflow["input_schema"]["properties"]["data_type_intent"]["oneOf"][2]
    warehouse_resolved = workflow["input_schema"]["properties"]["warehouse_intent"]["oneOf"][2]
    assert set(data_type_resolved["properties"]) == {"state", "values"}
    assert set(warehouse_resolved["properties"]) == {"state", "values"}
    assert "即使只选一种" in data_type_resolved["properties"]["values"]["description"]
    assert "单仓也必须是单元素数组" in warehouse_resolved["properties"]["values"]["description"]
    assert "global/all" in warehouse_resolved["properties"]["values"]["description"]
    assert workflow["input_schema"]["properties"]["created_date_filter"]["oneOf"]
    explicit_range = workflow["input_schema"]["properties"]["created_date_filter"]["oneOf"][4]
    assert explicit_range["required"] == ["state", "mode", "start_date", "end_date"]
    inventory_snapshot = workflow["input_schema"]["properties"]["inventory_snapshot_intent"]
    assert inventory_snapshot["type"] == "object"
    assert inventory_snapshot["properties"]["state"]["enum"] == [
        "current", "historical", "omitted", "ambiguous",
    ]
    assert inventory_snapshot["required"] == ["state"]
    assert inventory_snapshot["additionalProperties"] is False
    assert workflow["artifact_paths"] == [{"field": "artifacts[].path", "role": "deliverable"}]
    assert workflow["deliver_artifacts_on_failure"] is True
    assert "lxeskill yacang export run" in router.split("---", 2)[1]
    assert "needs_clarification" in router
    assert "created_date_filter" in router
    assert "禁止自行尝试相似 endpoint" in router
    assert "不得改走其他雅仓命令冒充成功" in router
    assert "当前轮" in router
    assert "历史 Context" in router
    assert '严禁传单数字段 `value`' in router
    assert "request_text" not in router
    assert "sales-monthly" not in router
    assert "sales-90d" not in router
    assert '{"state":"resolved","values":["VN8806"]}' in router
    assert '{"state":"resolved","values":["MY8801","VN8806"]}' in router
    assert "覆盖四仓的 global/all 文件" in router

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


def test_four_platform_skill_boundaries_are_explicit_and_brazil_documents_support_both() -> None:
    catalog = load_catalog()
    shangman = _skill_text("shangman-goods-export-workflow-map")
    zhihui = _skill_text("zhihui-tms-product-export")
    brazil = _skill_text("replenishment-workflow-map")

    assert "雅仓" in shangman and "智汇" in shangman and "马帮" in shangman
    assert "雅仓" in zhihui and "上马印尼" in zhihui and "马帮" in zhihui
    assert not (PROJECT_ROOT / "skills" / "replenishment-brazil-overseas-export" / "SKILL.md").exists()
    assert "name: replenishment-workflow-map" in brazil.split("---", 2)[1]
    assert "lxeskill replenish brazil-overseas export" in brazil.split("---", 2)[1]
    assert "Brazil Overseas 上下文明确时，单据/调拨单据" in brazil
    assert "allocation_both" in brazil
    assert "当前轮" in brazil

    entry = catalog["mabang_brazil_overseas_export"]
    assert entry["owner_skills"] == ["replenishment-workflow-map"]
    export_kind = entry["input_schema"]["properties"]["export_kind"]
    assert "allocation_both" in export_kind["enum"]
    assert entry["artifact_paths"] == [
        {"field": "xlsx_path", "role": "deliverable"},
        {"field": "xlsx_paths[]", "role": "deliverable"},
    ]


def test_zhihui_product_export_is_direct_execute_without_manual_confirmation() -> None:
    text = _skill_text("zhihui-tms-product-export")

    assert "正常导出请求直接调用 `execute`" in text
    assert "先调用 preview；再调用 execute" not in text
    assert "确认执行导出" not in text
    assert "confirmation_required=true" not in text


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
