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
    "fba-purchase-contract-fill",
    "fba-purchase-summary-create",
    "fba-restock-workbook-create",
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
    assert 'A --> D["fba-invoice-template-fill<br/>发票导入模板"]' in text
    assert "E --> D" in text
    assert 'L["备货单 xlsx"] --> D' in text
    assert 'A --> H["fba-customs-declaration-fill<br/>报关资料"]' in text
    assert 'E --> H["fba-customs-declaration-fill<br/>报关资料"]' in text
    assert 'L["备货单 xlsx"] --> H' in text
    assert "发票资料 | 备货单 + FBA 发货单 CSV + 本地 WMS 装箱数据 -> `fba-invoice-template-fill`" in text
    assert "报关资料 | 备货单 + FBA 发货单 CSV + 本地 WMS 装箱数据 -> `fba-customs-declaration-fill`" in text
    assert 'A --> M["fba-purchase-summary-create<br/>采购汇总表生成"]' in text
    assert 'N["出口退税总表 xlsx"] --> M' in text
    assert 'M --> P["fba-purchase-contract-fill<br/>采购合同填写"]' in text
    assert 'Q["合同汇总模板 xlsx"] --> P' in text
    assert 'A --> O["fba-restock-workbook-create<br/>备货单生成"]' in text
    assert "N --> O" in text
    assert "采购汇总表生成 | FBA 发货单 CSV + 出口退税总表 -> `fba-purchase-summary-create`" in text
    assert "采购合同填写 | 采购汇总表 + 合同汇总模板 -> `fba-purchase-contract-fill`" in text
    assert "备货单生成 | 单个 FBA 发货单 CSV + 出口退税总表 -> `fba-restock-workbook-create`" in text
    assert "采购汇总表可多 SP 且包含厂家分类 sheet" in text
    assert "备货单只允许单 SP 且不生成厂家分类 sheet" in text


def test_fba_invoice_template_skill_documents_actual_quantity_contract() -> None:
    text = _skill_text("fba-invoice-template-fill")

    assert "quantity_basis=actual" in text
    assert "WMS `装箱数量` 是发票模板的实际发货量来源" in text
    assert "发货单 CSV 只提供 `MSKU -> 库存 SKU` 组成关系" in text
    assert "备货单第一个表格提供 `库存 SKU -> 规则型号` 映射" in text
    assert "汇总表 `SKU` 作为型号组代表行" in text
    assert "不按汇总表预期 `发货量` 填写正式数量" in text
    assert "`汇总表计算前后对比`" in text


def test_fba_customs_declaration_skill_documents_actual_quantity_contract() -> None:
    text = _skill_text("fba-customs-declaration-fill")

    assert "缺失时正式报关资料仍会生成" not in text
    assert "quantity_basis=actual" in text
    assert "WMS `装箱数量` 是正式报关资料的实际发货量来源" in text
    assert "解析 `MSKU -> 库存 SKU` 组成关系" in text
    assert "备货单第一个表格提供 `库存 SKU -> 规则型号` 映射" in text
    assert "汇总表 `SKU` 作为型号组代表行" in text
    assert "`汇总表计算前后对比`" in text


def test_fba_purchase_summary_skill_documents_contract() -> None:
    text = _skill_text("fba-purchase-summary-create")

    assert "services.agent_cli.mabang.generate_purchase_summary_workbook" in text
    assert "--delivery-no" in text
    assert "--master-xlsx" in text
    assert "artifacts/mabang_fba_delivery/<SP>_*.csv" in text
    assert "不自动下载" in text
    assert "`SKU表` sheet" in text
    assert "`库存sku` 或 `库存SKU`" in text
    assert "`供应商合同信息` sheet 用 `供货方` 匹配 `SKU表` 的 `厂家`" in text
    assert "`单位`、`合同产品名称`、`合同编号前缀` 和 `税率`" in text
    assert "contract_mapping_count" in text
    assert "采购汇总表已生成" in text
    assert "第一个 sheet 是 `采购汇总`，第二个 sheet 是 `未匹配`" in text
    assert "`未匹配` sheet" in text
    assert "`库存sku`、`来源SP单号`、`数量`、`问题说明`" in text
    assert "sku_source_count" in text
    assert "如果 `warnings` 非空" in text
    assert "已自动去重" in text
    assert "`库存sku` 为空的行且已忽略" in text
    assert "按 `型号` 合并" in text
    assert "`库存sku`、`产品名称` 单元格中按相同顺序分行显示" in text
    assert "`来源SP单号` 按型号组去重并分行显示" in text
    assert "`库存sku（第一行）`、`产品名称（第一行）`" in text
    assert "来源SP单号（第一行）" not in text
    assert "`厂家`、`单位`、`合同产品名称`、`合同编号前缀`、`税率`、`数量`、`总价`" in text
    assert "所有列宽和行高已统一为 15" in text


def test_fba_purchase_contract_fill_skill_documents_contract() -> None:
    text = _skill_text("fba-purchase-contract-fill")

    assert "services.agent_cli.mabang.fill_purchase_contracts" in text
    assert "--purchase-summary-xlsx" in text
    assert "--contract-template-xlsx" in text
    assert "采购汇总表 xlsx 和合同汇总模板 xlsx" in text
    assert "每家公司一个 xlsx" in text
    assert "`附加件明细模板`" in text
    assert "`补充协议附加件明细`" in text
    assert "对应公司合同 sheet 和 `补充协议附加件明细` sheet" in text
    assert "合同编号本阶段不处理" in text
    assert "附加件里的采购合同编号也不处理" in text
    assert "找不到厂家模板 sheet" in text
    assert "运行当天 + 3 天" in text
    assert "税率来自采购汇总表" in text
    assert "`产品名称=合同产品名称`" in text
    assert "模板有 `规格型号` 列时才写入 `型号`" in text


def test_fba_restock_workbook_skill_documents_contract() -> None:
    text = _skill_text("fba-restock-workbook-create")

    assert "services.agent_cli.mabang.generate_fba_restock_workbook" in text
    assert "--delivery-no" in text
    assert "--master-xlsx" in text
    assert "--gross-margin" in text
    assert "一次只能处理一个 `SP` 发货单号" in text
    assert "多个 SP 要拆成多次运行" in text
    assert "artifacts/mabang_fba_delivery/<SP>_*.csv" in text
    assert "不自动下载" in text
    assert "`SKU表` sheet" in text
    assert "`库存sku` 或 `库存SKU`" in text
    assert "`供应商合同信息` sheet 用 `供货方` 匹配 `SKU表` 的 `厂家`" in text
    assert "`单位`、`合同产品名称` 和 `税率`" in text
    assert "`0.2` 到 `0.5`" in text
    assert "毛利率" in text
    assert "售价 = 原价 / 含税倍率 / (1 - 毛利率)" in text
    assert "`13%` 按含税倍率 `1.13`" in text
    assert "售价四舍五入保留两位小数" in text
    assert "总价（售价）" in text
    assert "合同编号前缀" not in text
    assert "contract_mapping_count" in text
    assert "不生成厂家分类 sheet" in text
    assert "备货单已生成" in text
    assert "第一个是 `备货单`，第二个是 `未匹配`" in text
    assert "`未匹配` sheet" in text
    assert "`库存sku`、`数量`、`问题说明`" in text
    assert "`来源SP单号`" not in text
    assert "如果 `warnings` 非空" in text
    assert "不同厂家有相同型号" in text
    assert "业务人员需要核查" in text
    assert "按 `型号` 合并" in text
    assert "不同厂家相同型号会保留为不同行" in text
    assert "`原价`、`售价`、`厂家`、`单位`、`合同产品名称`、`数量`、`总价`、`总价（售价）`" in text
    assert "所有列宽和行高已统一为 15" in text


def test_fba_purchase_summary_skill_does_not_require_pricing_margin() -> None:
    text = _skill_text("fba-purchase-summary-create")

    assert "--gross-margin" not in text
    assert "毛利率" not in text
    assert "售价" not in text


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
