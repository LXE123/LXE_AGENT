---
name: fba-delivery-tax-summary
description: 统计 FBA 发货单出口退税 SKU 汇总。用户要求按 SP 发货单统计出口退税产品、汇总 SKU 发货量、生成退税产品 xlsx 时使用。
type: amazon_store
---

## When to Use

- 用户要统计 FBA 发货单里的出口退税产品。
- 用户提供 `SP...` 发货单号，并要求汇总 SKU 发货量。
- 用户说“统计这个的出口退税产品”“导出退税 SKU 汇总”等需求。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.summarize_fba_delivery_tax_sku`
- 不要自己解析 CSV。
- 不要自己生成 xlsx。
- 退税产品白名单固定来自 `data/export_tax/export_tax_products.xls` 的 `Sheet1`。
- 不要手写或复用 bearer/freeToken。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Required Input

- 必须有一个 `delivery_no`。
- 单号必须是 `SP` 开头的发货单号。
- 如果用户没有提供 `SP...` 单号，先追问，不要启动 CLI。

## How to Execute

固定执行：

```powershell
uv run --frozen python -m services.agent_cli.mabang.summarize_fba_delivery_tax_sku --delivery-no <delivery_no>
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "delivery_no": "SP260508022",
  "csv_path": "artifacts/mabang_fba_delivery/SP260508022_370630.csv",
  "xlsx_path": "artifacts/mabang_fba_tax_summary/SP260508022_tax_summary.xlsx",
  "sku_count": 29,
  "matched_sku_count": 12,
  "unmatched_sku_count": 17,
  "source": "fba_delivery_tax_summary"
}
```

失败时：

```json
{
  "success": false,
  "delivery_no": "SP260508022",
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户出口退税 SKU 汇总 xlsx 已生成，并提供 `xlsx_path`。
- 结果文件包含两个 sheet：`可出口退税` 和 `不可出口退税`。
- `success=false`：只转述 `exception`。
