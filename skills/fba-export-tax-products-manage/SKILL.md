---
name: fba-export-tax-products-manage
description: 维护出口退税产品白名单。用户要求把 SKU 加入出口退税产品列表、导入可出口退税 SKU、更新退税产品白名单时使用。
type: amazon_fba
script_tools:
  - mabang_import_export_tax_products
---

# Export Tax Products Manage

## Hard Rules

- 必须直接调用 frontmatter script_tools 中声明的工具；禁止通过 exec、process、shell 或 python -m 启动对应业务模块。
- 下方命令样式只表示工具名与参数，不是 shell 命令；调用时按工具 JSON schema 传参。

- 只使用固定 CLI。
- 不要自己编辑 `data/export_tax/export_tax_products.xlsx`。
- 不要自己查询或拼接马帮 API 请求，不要手写或复用 bearer/freeToken/Cookie。
- v1 只支持导入新增 SKU，不支持删除、修改、查询。
- 已存在 SKU 不导入、不覆盖；马帮 API 查不到的 SKU 不导入。

## Required Input

- 至少一个 SKU，例如 `DX260430201`、`DX260428212`、`DX241122C06`。
- 没有 SKU 时先追问，不要启动 CLI。

## Command

```text
mabang_import_export_tax_products --sku <sku1> --sku <sku2>
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户 `imported_count`、`skipped_duplicate_count`、`skipped_not_found_count`。
- `backup_path` 非空：说明导入前已自动备份。
- `success=false`：只转述 `exception`。
