---
name: fba-purchase-summary-create
description: 根据一个或多个本地 FBA 发货单 CSV 和用户提供的出口退税总表生成采购汇总表。用户要求按 SP 发货单生成采购汇总、厂家分类采购表、按出口退税总表匹配厂家/型号/原价并汇总库存 SKU 数量时使用；不要用于 WMS 装箱数据、Amazon 创建货件、发票模板或报关资料。
type: amazon_fba
---

# FBA Purchase Summary Create

## Hard Rules

- 只使用固定 CLI。
- 不要手工解析 CSV，不要手工编辑 Excel。
- 发货单 CSV 只从本地 `artifacts/mabang_fba_delivery/<SP>_*.csv` 查找；缺少时直接转述 CLI 失败原因，不自动下载。
- 出口退税总表必须由用户提供，不使用默认路径。
- `备用厂家` 暂不参与输出。

## Required Input

- `delivery_no`: 一个或多个 `SP` 开头的发货单号。
- `master_xlsx`: 用户提供的出口退税总表 xlsx。
- 出口退税总表必须包含 `SKU表` sheet；其中库存 SKU 列名可写 `库存sku` 或 `库存SKU`。
- 出口退税总表的 `供应商合同信息` sheet 用 `供货方` 匹配 `SKU表` 的 `厂家`，读取 `单位` 和 `合同产品名称`；缺失或冲突时 CLI 会生成文件并在 `warnings` 中提醒。
- 缺少 `SP...` 或缺少出口退税总表路径时先追问，不要启动 CLI。

## Command

```powershell
uv run --frozen python -m services.agent_cli.mabang.generate_purchase_summary_workbook --delivery-no <delivery_no> --master-xlsx "<出口退税总表.xlsx>"
```

多个发货单号时重复传入 `--delivery-no`：

```powershell
uv run --frozen python -m services.agent_cli.mabang.generate_purchase_summary_workbook --delivery-no <delivery_no_1> --delivery-no <delivery_no_2> --master-xlsx "<出口退税总表.xlsx>"
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户采购汇总表已生成，并提供 `output_xlsx`。
- 可简要转述 `sku_count`、`sku_source_count`、`matched_sku_count`、`unmatched_sku_count`、`manufacturer_count`、`contract_mapping_count`。
- 如果 `warnings` 非空，必须转述给用户；例如出口退税总表存在完全相同的重复库存 SKU 且已自动去重、存在 `库存sku` 为空的行且已忽略，或 `供应商合同信息` sheet 的 `供货方` 映射缺失/冲突。
- 说明第一个 sheet 是 `采购汇总`，第二个 sheet 是 `未匹配`，后续 sheet 是厂家分类。
- 说明 `采购汇总` 和厂家 sheet 已按 `型号` 合并；同型号多个库存 SKU 会在 `库存sku`、`产品名称` 单元格中按相同顺序分行显示，`来源SP单号` 按型号组去重并分行显示。
- 说明 `采购汇总` 和厂家 sheet 额外提供 `库存sku（第一行）`、`产品名称（第一行）`，用于筛选或复制代表值。
- 说明输出表格所有列宽和行高已统一为 15。
- 说明 `采购汇总` 和厂家 sheet 字段为 `库存sku`、`产品名称`、`来源SP单号`、`库存sku（第一行）`、`产品名称（第一行）`、`型号`、`原价`、`厂家`、`单位`、`合同产品名称`、`数量`、`总价`。
- 说明未匹配库存 SKU 会进入 `未匹配` sheet，字段为 `库存sku`、`来源SP单号`、`数量`、`问题说明`。
- `success=false`：只转述 `exception`；不要重跑下载发货单 CLI。
