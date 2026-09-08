# 报表与字段参考

以下字段均在 terminal 的 `data` 中；成功判定仍使用外层 `ok`，交付使用外层 `files`。

- 结果文件包含 4 个业务 Sheet，以及隐藏的 `源数据核验信息` Sheet。业务 Sheet 为：`真实库存（深圳仓库）-组合sku`、`真实库存（深圳仓库）-库存sku`、`无本地SKU`、`无库存数据`。
- `真实库存（深圳仓库）-组合sku` 和 `真实库存（深圳仓库）-库存sku` 包含列：`MSKU`、`父ASIN`、`ASIN`、`本地SKU`、`商品链接`、`FBA总库存`、`加权日销`、`可销售天数`、`真实库存（深圳仓库）数量`、`子SKU`；按 `加权日销` 降序。
- `无本地SKU` 和 `无库存数据` 包含列：`MSKU`、`父ASIN`、`ASIN`、`本地SKU`、`商品链接`、`真实库存（深圳仓库）数量`、`子SKU`。
- `商品链接` 直接复制自源 MSKU 文件；`FBA总库存 = 可售 + 待入库 + 预留 + 在途 + 待调仓 + 调仓中`；`加权日销 = 7天销量 / 7 * 0.6 + 14天销量 / 14 * 0.3 + 30天销量 / 30 * 0.1`。
- `source_msku_xlsx_path` = 源店铺 MSKU 数据文件。
- `source_msku_data_time` = 源店铺 MSKU 数据时间。
- `unique_local_sku_count` = 通过绑定核验且有本地 SKU 的去重本地 SKU 数。
- `detected_combo_sku_count` = 本次识别到的组合 SKU 数。
- `queried_warehouse_stock_sku_count` = 本次实际查询深圳仓库库存的去重库存 SKU 数；普通本地 SKU 按本身计，组合 SKU 会拆成子库存 SKU 后计数。
- `matched_warehouse_inventory_msku_row_count` = 成功得到深圳仓库库存数量的 MSKU 行数。
- `missing_local_sku_msku_row_count` = 源数据没有 `本地SKU`、未参与库存查询的 MSKU 行数。
- `missing_warehouse_inventory_msku_row_count` = 有 `本地SKU` 但没查到深圳仓库库存数量的 MSKU 行数。
- `missing_warehouse_stock_sku_count` = 查不到的库存 SKU 编号数。
- `missing_local_sku_msku_row_count > 0`：提醒这些 MSKU 源数据没有 `本地SKU`，没有参与库存查询，详情在 `无本地SKU` sheet。
- `missing_warehouse_inventory_msku_row_count > 0`：提醒这些 MSKU 有 `本地SKU` 但没有查到深圳仓库库存数量，详情在 `无库存数据` sheet。
- `missing_warehouse_stock_sku_count > 0`：明确提醒这些库存 SKU 未查到，相关报告行在 `无库存数据` sheet，`真实库存（深圳仓库）数量` 留空。
- 结果文件是独立 xlsx，文件名前缀使用源 MSKU 数据时间 `source_msku_data_time`，方便后续备货计算和销量分析报告做同源匹配；不会修改店铺 MSKU 源文件或销量分析报告。
- `original_row_count`、`binding_verified_row_count`、`binding_unverified_row_count` 记录源表范围；其余库存数量统计按各字段区分已核验库存行、无本地 SKU 及未核验行。
