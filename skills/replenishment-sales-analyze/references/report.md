# 报表与字段参考

以下字段均在 terminal 的 `data` 中；成功判定仍使用外层 `ok`，交付使用外层 `files`。

- 报告包含 `链接销量前10`、`其他链接`、`ASIN销量前50`、`其他ASIN`、`MSKU明细` 5 个业务 Sheet，以及隐藏的 `源数据核验信息` Sheet（随源表传递核验信息）。
- 前 4 个聚合 Sheet 在 `加权日销` 前提供 `商品链接`：链接维度使用源表商品链接前缀拼接 `父ASIN`，ASIN 维度保留源表中的商品链接。
- 源表须包含新版 `源数据核验信息`。MSKU、ASIN、链接三个维度均汇总源表 XLSX 的全部记录（含库存和组合商品接口均未命中的记录）；商品类型绑定核验仅限制 V1 备货计算范围。
- `original_row_count`、`binding_verified_row_count`、`binding_unverified_row_count` 分别表示源表原始行数、绑定核验通过行数、未通过行数；`msku_count` 为参与销量分析的总行数。
