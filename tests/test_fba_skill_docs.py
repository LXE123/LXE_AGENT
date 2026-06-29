from __future__ import annotations

from pathlib import Path

from agent_runtime.skill_index import load_skill_index


FBA_SKILLS = {
    "fba-customs-declaration-fill",
    "fba-export-tax-delivery-summary",
    "fba-export-tax-products-manage",
    "fba-invoice-template-fill",
    "fba-logistics-rate-import",
    "fba-logistics-select",
    "fba-msku-detail-download",
    "fba-shipment-create",
    "fba-shipment-delivery-csv-download",
    "fba-shipment-wms-box-download",
    "fba-stock-sku-download",
    "fba-workflow-map",
}


def _skill_text(name: str) -> str:
    return (Path(__file__).resolve().parents[1] / "skills" / name / "SKILL.md").read_text(
        encoding="utf-8"
    )


def test_fba_skills_load_from_index() -> None:
    index = load_skill_index(force_reload=True)
    manifests = {manifest.name: manifest for manifest in index.all()}

    assert FBA_SKILLS.issubset(manifests)
    assert {manifests[name].type for name in FBA_SKILLS} == {"amazon_fba"}


def test_fba_shipment_create_keeps_stage_contracts() -> None:
    text = _skill_text("fba-shipment-create")

    assert "prepare_upload" in text
    assert "prepare_multi_box_excel" in text
    assert "confirm_own_carrier" in text
    assert "enter_tracking_codes" in text
    assert "第三段完成且已准备追踪号" not in text
    assert "| 4 `enter_tracking_codes` | 第三段完成 |" in text
    assert text.count("亚马逊店铺页面店铺出现bug，已返回第二步开头，请执行第二阶段CLI") == 1
    assert "如果 `file_path` 非空" in text
    assert "send_file" in text
    assert "不重跑 CLI" in text


def test_fba_wms_download_keeps_split_mode_contract() -> None:
    text = _skill_text("fba-shipment-wms-box-download")

    assert "下载前必须明确 `split-mode`" in text
    assert "--split-mode auto" in text
    assert "--split-mode original" in text
    assert "split_mode=original" in text
    assert "split_mode=auto" in text


def test_fba_workflow_map_keeps_invoice_and_customs_independent() -> None:
    text = _skill_text("fba-workflow-map")

    assert 'D --> H["fba-customs-declaration-fill<br/>报关资料"]' not in text
    assert 'A --> H["fba-customs-declaration-fill<br/>报关资料"]' in text
    assert 'E --> H["fba-customs-declaration-fill<br/>报关资料"]' in text
    assert 'L["备货单 xlsx"] --> H' in text
    assert "报关资料 | 备货单 + FBA 发货单 CSV + 本地 WMS 装箱数据 -> `fba-customs-declaration-fill`" in text


def test_fba_customs_declaration_skill_documents_actual_quantity_contract() -> None:
    text = _skill_text("fba-customs-declaration-fill")

    assert "缺失时正式报关资料仍会生成" not in text
    assert "quantity_basis=actual" in text
    assert "WMS `装箱数量` 是正式报关资料的实际发货量来源" in text
    assert "解析 `MSKU -> 库存 SKU` 组成关系" in text
    assert "备货单第一个表格提供 `库存 SKU -> 规则型号` 映射" in text
    assert "汇总表 `SKU` 作为型号组代表行" in text
    assert "`汇总表计算前后对比`" in text


def test_fba_skill_docs_do_not_contain_old_misleading_phrases() -> None:
    root = Path(__file__).resolve().parents[1] / "skills"
    forbidden = [
        "毫无意义",
        "出问题直接丢给用户",
        "发送到群里失败",
    ]

    for skill_path in sorted(root.glob("fba-*/SKILL.md")):
        text = skill_path.read_text(encoding="utf-8")
        for phrase in forbidden:
            assert phrase not in text, f"{skill_path} still contains {phrase}"
