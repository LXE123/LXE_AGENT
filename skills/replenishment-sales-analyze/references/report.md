# 报表与字段参考

以下字段均在 terminal 的 `data` 中；成功判定仍使用外层 `ok`，交付使用外层 `files`。

- 同时说明源数据文件 `source_xlsx_path`、源数据时间 `source_data_time`、链接数、ASIN 表行数和 MSKU 数。
- 报告包含 `链接销量前10`、`其他链接`、`ASIN销量前50`、`其他ASIN`、`MSKU明细` 5 个 sheet。
- 前 4 个聚合 sheet 在 `加权日销` 前提供 `商品链接`；链接维度会用源数据商品链接前缀拼接 `父ASIN`，ASIN 维度保留源数据里的商品链接。
- 源表需要包含下载时生成的 Active 核验信息；旧版源表需重新下载。MSKU、ASIN、链接三个维度均只汇总确认 Active 的行。
- 原始、参与、排除行数分别为 `original_row_count`、`active_row_count`、`excluded_row_count`；`msku_count` 是参与销量分析的行数。
