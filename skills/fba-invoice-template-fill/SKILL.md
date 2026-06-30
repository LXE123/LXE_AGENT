---
name: fba-invoice-template-fill
description: 根据用户上传的备货 xlsx、本地 FBA 发货单 CSV 和本地 WMS 装箱数据填写发票导入模板，按 WMS 实际发货量生成 invoice_Template 和数量校验报告。用户要求填写发票模板、生成发票导入表、把备货单写入 invoice_Template，或为 FBA 发票资料准备模板时使用。
type: amazon_fba
---

# Invoice Template Fill

## Hard Rules

- 只使用固定 CLI。
- 不要手动编辑用户备货单或 `data/invoice_Template/invoice_Template.xlsx`。
- 不要自己拼接马帮 API 请求，不要手写或复用 Cookie/token。
- 只使用本地已有 FBA 发货单 CSV 和 WMS 装箱数据；缺文件时转述 CLI 失败原因，不自动补下载。
- WMS `装箱数量` 是发票模板的实际发货量来源；发货单 CSV 只提供 `MSKU -> 库存 SKU` 组成关系。
- 备货单第一个表格提供 `库存 SKU -> 规则型号` 映射；汇总表 `SKU` 作为型号组代表行。
- 发票明细按 `箱号 + 汇总表代表 SKU` 写入；实际发货量为 0 的代表行不写入模板。
- 产品图片来自库存 SKU Excel 的 `库存sku图片`。
- 不按汇总表预期 `发货量` 填写正式数量。
- 材质、用途、申报价规则无法匹配时，CLI 会在 `notice` 中提示。

## Required Input

- 一个备货 `.xlsx` 文件。
- 文件名必须包含 `SP...` 单号和目的国。
- 本地必须已存在对应的 FBA 发货单 CSV：`artifacts/mabang_fba_delivery/<SP单号>_*.csv`。
- 本地必须已存在对应的 WMS 装箱数据 Excel。
- 缺少文件时先追问，不要启动 CLI。

## Command

```powershell
uv run --frozen python -m services.agent_cli.mabang.fill_invoice_template --input-xlsx <备货单.xlsx>
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户发票模板已生成，并提供 `output_xlsx`。
- 确认 `quantity_basis=actual`。
- 如果有 `validation_report_xlsx`，告诉用户数量校验报告也已生成，包含 `数量校验`、`汇总表计算前后对比`、`数据来源`。
- 可简要转述 `invoice_row_count`、`box_count`、`image_missing_count`。
- `notice` 非空：简要转述缺图或缺少申报价规则的提示。
- `success=false`：只转述 `exception`。
