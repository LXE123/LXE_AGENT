---
name: fba-invoice-template-fill
description: 填写发票导入模板。用户上传备货 xlsx 并要求填写发票模板、生成发票导入表、把备货单写入 invoice_Template，或为 FBA 发票资料准备模板时使用。
type: amazon_fba
---

# Invoice Template Fill

## Hard Rules

- 只使用固定 CLI。
- 不要手动编辑用户备货单或 `data/invoice_Template/invoice_Template.xlsx`。
- 不要自己拼接马帮 API 请求，不要手写或复用 Cookie/token。
- 只使用本地已有 FBA 发货单 CSV 和 WMS 装箱数据；缺文件时转述 CLI 失败原因，不自动补下载。
- 发票明细按 `箱号 + 财务合并后的库存SKU` 写入，财务合并规则由 CLI 执行。
- 产品图片来自库存 SKU Excel 的 `库存sku图片`。
- 申报数量来自装箱数据内按 `规则型号 + 单价` 归并后的箱内数量，不直接使用汇总发货量。
- 材质、用途、申报价规则无法匹配时，CLI 会在 `notice` 中提示。

## Required Input

- 一个备货 `.xlsx` 文件。
- 文件名必须包含 `SP...` 单号和目的国。
- 缺少文件时先追问，不要启动 CLI。

## Command

```powershell
uv run --frozen python -m services.agent_cli.mabang.fill_invoice_template --input-xlsx <备货单.xlsx>
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户发票模板已生成，并提供 `output_xlsx`。
- 可简要转述 `invoice_row_count`、`box_count`、`image_missing_count`。
- `notice` 非空：简要转述缺图或缺少申报价规则的提示。
- `success=false`：只转述 `exception`。
