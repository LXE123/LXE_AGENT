---
name: fba-export-tax-delivery-summary
description: 统计 FBA 发货单出口退税 SKU 汇总。用户要求按 SP 发货单统计出口退税产品、汇总 SKU 发货量、生成退税产品 xlsx 时使用。
type: amazon_fba
---

# Export Tax Delivery Summary

## Hard Rules

- 只使用固定 CLI。
- 不要自己解析 CSV，不要自己生成 xlsx。
- 退税产品白名单来自 `data/export_tax/export_tax_products.xlsx`。
- 不可出口退税 SKU 的产品名由 CLI 自动通过马帮库存 SKU 导出补全。
- 不要手写或复用 bearer/freeToken/Cookie。

## Required Input

- `delivery_no`: `SP` 开头的发货单号。
- 缺少 `SP...` 时先追问，不要启动 CLI。

## Command

```powershell
uv run --frozen python -m services.agent_cli.mabang.summarize_fba_delivery_tax_sku --delivery-no <delivery_no>
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户出口退税 SKU 汇总 xlsx 已生成，并提供 `xlsx_path`。
- 说明结果包含 `可出口退税` 和 `不可出口退税` 两个 sheet。
- 可简要转述 `matched_sku_count`、`unmatched_sku_count`、`stock_name_missing_count`。
- `success=false`：只转述 `exception`。
