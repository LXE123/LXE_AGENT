---
name: fba-restock-workbook-create
description: 兼容入口：根据一个本地 FBA 发货单 CSV、用户提供的出口退税总表和毛利率独立生成单 SP 备货单。仅当用户明确要求单个 SP 独立生成且不需要一批 SP 的正飞统一均价时使用；日常一批 SP 的采购汇总表和备货单生成应使用 fba-purchase-summary-create。
type: amazon_fba
---

# FBA Restock Workbook Create

## Hard Rules

- 只使用固定 CLI。
- 不要手工解析 CSV，不要手工编辑 Excel。
- 一次只能处理一个 `SP` 发货单号；多个 SP 要拆成多次运行，每个 SP 一个文件。
- 这是兼容入口；如果用户在处理一批 SP，或要求正飞按整批统一均价，必须改用 `fba-purchase-summary-create`。
- 发货单 CSV 只从本地 `artifacts/mabang_fba_delivery/<SP>_*.csv` 查找；缺少时直接转述 CLI 失败原因，不自动下载。
- 出口退税总表必须由用户提供，不使用默认路径。
- 不生成厂家分类 sheet。

## Required Input

- `delivery_no`: 一个 `SP` 开头的发货单号。
- `master_xlsx`: 用户提供的出口退税总表 xlsx。
- `gross_margin`: 用户指定的毛利率，必须在 `0.2` 到 `0.5` 之间。
- 出口退税总表必须包含 `SKU表` sheet；其中库存 SKU 列名可写 `库存sku` 或 `库存SKU`。
- 出口退税总表的 `供应商合同信息` sheet 用 `供货方` 匹配 `SKU表` 的 `厂家`，读取 `单位`、`合同产品名称` 和 `税率`；缺失或冲突时 CLI 会失败或在 `warnings` 中提醒。
- 缺少 `SP...`、出口退税总表路径或毛利率时先追问，不要启动 CLI。

## Command

```powershell
uv run --frozen python -m services.agent_cli.mabang.generate_fba_restock_workbook --delivery-no <delivery_no> --master-xlsx "<出口退税总表.xlsx>" --gross-margin <毛利率>
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户备货单已生成，并提供 `output_xlsx`。
- 可简要转述 `sku_count`、`sku_source_count`、`matched_sku_count`、`unmatched_sku_count`、`manufacturer_count`、`contract_mapping_count`。
- 如果 `warnings` 非空，必须转述给用户；尤其是出现“不同厂家有相同型号”、发货单 CSV `国家` 缺失/为空/存在多个不同国家，或 `供应商合同信息` sheet 的 `供货方` 映射缺失/冲突时，明确提醒业务人员需要核查。
- 说明输出文件名格式为 `M.D-<SP>-新棱镜备货-<国家>.xlsx`；日期使用生成当天，国家来自发货单 CSV 的 `国家` 字段，缺失时使用 `未知国家`。
- 说明输出只有两个 sheet：第一个是 `备货单`，第二个是 `未匹配`，没有厂家分类 sheet。
- 说明 `备货单` 已按 `型号` 合并，但不同厂家相同型号会保留为不同行；同型号多个库存 SKU 会在 `库存sku`、`产品名称` 单元格中按相同顺序分行显示，并额外提供 `库存sku（第一行）`、`产品名称（第一行）` 用于筛选或复制代表值。
- 说明 `厂家` 单元格已开启自动换行，长厂家名不会横向溢出到后续字段。
- 说明 `日期` 使用生成当天 `YYYY-MM-DD`，`采购订单号` 固定留空并填充颜色，方便业务人员后续补录。
- 说明 `售价 = 原价 / 含税倍率 / (1 - 毛利率)`；`13%` 按含税倍率 `1.13` 计算，售价四舍五入保留两位小数。
- 说明本兼容入口的正飞 `均价 = sum(原价 * 数量) / sum(数量)` 只按当前单个 SP 计算；一批 SP 的统一均价必须使用 `fba-purchase-summary-create`。
- 说明厂家名包含 `正飞` 的明细行会填写 `总价（均价） = 均价 * 数量`、`售价(均价) = 均价 / 含税倍率 / (1 - 毛利率)` 和 `总价（售价(均价)） = 售价(均价) * 数量`；非正飞行这些字段留空。
- 说明 `备货单` 最后一行是带填充色的 `合计` 行，会汇总 `数量`、`总价（原价）`、`总价（均价）`、`总价（售价）` 和 `总价（售价(均价)）`。
- 说明 `库存sku`、`产品名称`、`售价(均价)` 和 `总价（售价(均价)）` 位于最后四列，并使用灰色填充。
- 说明输出表格所有列宽和行高已统一为 15。
- 说明 `备货单` 字段为 `日期`、`库存sku（第一行）`、`产品名称（第一行）`、`厂家`、`采购订单号`、`合同产品名称`、`单位`、`型号`、`数量`、`原价`、`均价`、`售价`、`总价（原价）`、`总价（均价）`、`总价（售价）`、`毛利率`、`库存sku`、`产品名称`、`售价(均价)`、`总价（售价(均价)）`。
- 说明未匹配库存 SKU 会进入 `未匹配` sheet，字段为 `库存sku`、`数量`、`问题说明`。
- `success=false`：只转述 `exception`；不要重跑下载发货单 CLI。
