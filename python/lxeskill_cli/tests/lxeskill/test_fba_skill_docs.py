from __future__ import annotations

from lxeskill.business import load_catalog
from shared.repository import repository_root


PROJECT_ROOT = repository_root()


def _skill_text(name: str) -> str:
    return (PROJECT_ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")


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


def test_delivery_window_skill_owns_two_session_commands_and_keeps_write_gate() -> None:
    catalog = load_catalog()
    list_entry = catalog["amazon_fba_delivery_window_list"]
    apply_entry = catalog["amazon_fba_delivery_window_apply"]

    assert list_entry["command_path"] == ["fba", "shipment", "delivery-window-list"]
    assert apply_entry["command_path"] == ["fba", "shipment", "delivery-window"]
    for entry in (list_entry, apply_entry):
        assert entry["owner_skills"] == ["fba-shipment-delivery-window"]
        assert entry["session_mode"] == "lxe_session"
        assert entry["visibility"] == "business"
        assert entry["artifact_paths"] == [
            {"field": "file_path[].value", "role": "diagnostic"}
        ]

    schema = apply_entry["input_schema"]
    assert schema["properties"]["action"]["enum"] == ["discover", "apply"]
    assert schema["properties"]["apply"]["type"] == "boolean"
    assert schema["properties"]["timeout_sec"] == {
        "type": "integer",
        "minimum": 1,
        "maximum": 600,
    }
    assert schema["required"] == ["store_id", "page_url", "shipment_ids"]

    skill = _skill_text("fba-shipment-delivery-window")
    frontmatter = skill.split("---", 2)[1]
    assert frontmatter.count("lxeskill fba shipment delivery-window") == 2
    assert "禁止直接执行 Python 模块" in skill
    assert "必须先用完全相同的店铺、页面 URL、货件号和目标日期" in skill
    assert "批准后只执行一次同参数 `apply=true`" in skill
    assert 'status="applied"' in skill
    assert "`applied_window` 精确等于目标周" in skill
    assert "任何修改请求都必须先执行 discovery" in skill
    assert "货件编号 1" in skill
    assert "默认不展示 `fba_shipment_id`" in skill
    assert "请选择要修改的货件编号（可多选）" in skill
    assert "同一修改流程只执行一次 discovery" in skill
    assert "直接复用当前 DOM" in skill
    assert "不主动调用 `send_files`" in skill


def test_logistics_flow_has_only_login_and_write_confirmations() -> None:
    logistics = _skill_text("fba-logistics-query")
    delivery = _skill_text("fba-shipment-delivery-window")
    carrier = (PROJECT_ROOT / "skills" / "fba-shipment-delivery-window" /
               "references" / "carrier-evidence.md").read_text(encoding="utf-8")

    assert "整条只读链最多一次登录确认" in logistics
    assert "不得在物流商查询、尾程跳转、尾程搜索、页面读取或返回 Amazon 之间逐步询问" in logistics
    assert "物流商查询成功并取得明确尾程单号后立即继续官方追踪" in logistics
    assert "自动继续明确的后续页，不逐页询问用户" in logistics
    assert "全流程最多保留两个确认点" in delivery
    assert "登录确认" in delivery and "修改确认" in delivery
    assert "dry-run 是只读准备步骤，必须自动执行" in delivery
    assert "不再请求第三次确认" in delivery
    assert "无需分别确认物流商查询、打开承运商页面、输入单号、读取结果或返回 Amazon" in carrier
    assert "中间不再确认" in carrier


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
