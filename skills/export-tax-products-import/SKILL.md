---
name: export-tax-products-import
description: 维护出口退税产品白名单。用户要求把一批 SKU 加入出口退税产品列表、导入可出口退税 SKU、更新退税产品白名单时使用。
type: amazon-fba
---

## When to Use

- 用户要把 SKU 加入出口退税产品白名单。
- 用户说“帮我把这些 SKU 写入出口退税产品列表”“导入这些退税 SKU”等需求。
- 用户只提供 SKU，产品名需要从马帮库存 SKU 导出接口获取。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.import_export_tax_products`
- 不要自己编辑 `data/export_tax/export_tax_products.xlsx`。
- 不要自己查询或拼接马帮 API 请求。
- 不要手写或复用 bearer/freeToken/Cookie。
- v1 只支持导入新增 SKU，不支持删除、修改、查询。
- 已存在于白名单的 SKU 不导入、不覆盖，只提示重复。
- 马帮 API 查不到的 SKU 不导入，只提示未找到。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Required Input

- 必须至少有一个 SKU。
- 从用户消息中提取 SKU，例如 `DX260430201`、`DX260428212`、`DX241122C06`。
- 如果没有 SKU，先追问，不要启动 CLI。

## How to Execute

固定执行：

```powershell
uv run --frozen python -m services.agent_cli.mabang.import_export_tax_products --sku <sku1> --sku <sku2>
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "requested_sku_count": 3,
  "imported_count": 2,
  "skipped_duplicate_count": 1,
  "skipped_not_found_count": 0,
  "imported_skus": ["DX260430201", "DX260428212"],
  "skipped_duplicate_skus": ["DX241122C06"],
  "skipped_not_found_skus": [],
  "products_path": "data/export_tax/export_tax_products.xlsx",
  "backup_path": "artifacts/export_tax_products_backup/export_tax_products_20260512_120000.xlsx",
  "source": "export_tax_products_import"
}
```

失败时：

```json
{
  "success": false,
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户导入数量、重复跳过数量、马帮未找到数量。
- 如果 `backup_path` 不为空，告诉用户导入前已自动备份。
- `success=false`：只转述 `exception`。
