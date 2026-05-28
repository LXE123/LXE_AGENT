---
name: mabang-fba-store-actual-inventory
description: 基于本地已下载的马帮 Amazon 店铺 MSKU 数据查询并生成真实库存报告。用户要求查看某个店铺 MSKU、本地SKU、组合SKU 或备货分析所需的真实库存数量时使用；如果用户只给模糊店铺名，先使用 mabang-fba-store-resolve 获取规范 store_name。
type: amazon_replenish
---

## When to Use

- 用户要获取某个马帮 Amazon 店铺 MSKU 对应的真实库存数量。
- 用户要在备货分析前补充 `本地SKU` 的库存数据。
- 用户已经下载过店铺 MSKU 数据，需要基于本地最新文件生成真实库存报告。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.export_store_msku_actual_inventory --store-name "<店铺名>"`
- 不要手动拼接马帮请求。
- 不要手写、复用或转述样例 Cookie/token。
- 不要自动下载店铺 MSKU 数据；本 skill 只分析本地已下载的店铺 MSKU 文件。
- 如果本地没有店铺 MSKU 数据文件，提示用户先运行 `mabang-fba-store-msku-download`。
- 如果用户给的是模糊店铺名，先运行 `mabang-fba-store-resolve`，用解析成功返回的规范 `store_name` 再查询库存。
- 只读取 CLI 输出的最后一行 JSON。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文。

## How to Execute

如果店铺名不确定，先解析店铺：

```powershell
uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store --store-name "<店铺名>"
```

解析成功后，用规范 `store_name` 查询真实库存：

```powershell
uv run --frozen python -m services.agent_cli.mabang.export_store_msku_actual_inventory --store-name "<店铺名>"
```

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-Lerxiuer-FR",
  "source_xlsx_path": "artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_msku_data.xlsx",
  "source_data_time": "202605251530",
  "local_sku_count": 120,
  "combo_sku_count": 8,
  "stock_sku_count": 135,
  "inventory_row_count": 118,
  "no_local_sku_count": 3,
  "no_inventory_row_count": 2,
  "missing_stock_sku_count": 2,
  "missing_stock_skus": ["SKU-A", "SKU-B"],
  "xlsx_path": "artifacts/mabang_store_msku_inventory/202605251530-Amazon-Lerxiuer-FR_actual_inventory.xlsx",
  "source": "mabang_store_msku_actual_inventory"
}
```

失败时：

```json
{
  "success": false,
  "store_name": "Amazon-Lerxiuer-FR",
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户真实库存报告已生成，并提供 `xlsx_path`。
- 同时说明源 MSKU 文件 `source_xlsx_path`、源数据时间 `source_data_time`、本地 SKU 数、组合 SKU 数、库存 SKU 数。
- 结果文件固定包含 4 个 sheet：`真实库存-组合sku`、`真实库存-库存sku`、`无本地SKU`、`无库存数据`。
- `真实库存-组合sku` 和 `真实库存-库存sku` 包含列：`MSKU`、`父ASIN`、`ASIN`、`本地SKU`、`商品链接`、`FBA总库存`、`加权日销`、`可销售天数`、`真实库存数量`、`子SKU`；按 `加权日销` 降序。
- `无本地SKU` 和 `无库存数据` 包含列：`MSKU`、`父ASIN`、`ASIN`、`本地SKU`、`商品链接`、`真实库存数量`、`子SKU`。
- `商品链接` 直接复制自源 MSKU 文件；`FBA总库存 = 可售 + 待入库 + 预留 + 在途`；`加权日销 = 7天销量 / 7 * 0.6 + 14天销量 / 14 * 0.3 + 30天销量 / 30 * 0.1`。
- `no_local_sku_count > 0`：提醒这些 MSKU 源数据没有 `本地SKU`，没有参与库存查询，详情在 `无本地SKU` sheet。
- `no_inventory_row_count > 0`：提醒这些 MSKU 有 `本地SKU` 但没有查到库存数量，详情在 `无库存数据` sheet。
- `missing_stock_sku_count > 0`：明确提醒这些库存 SKU 未查到，相关报告行在 `无库存数据` sheet，`真实库存数量` 留空。
- 结果文件是独立 xlsx，文件名前缀使用源 MSKU 数据时间 `source_data_time`，方便后续备货计算和销量分析报告做同源匹配；不会修改店铺 MSKU 源文件或销量分析报告。
