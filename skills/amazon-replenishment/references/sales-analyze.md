# Amazon 店铺销量分析报告

用于独立生成店铺链接销量、ASIN 销量、MSKU 销量趋势分析报告（V1/V2 备货计算直接读取 MSKU 源表，不依赖本报告）。

## 命令

基于本地已下载的店铺 MSKU 源表生成销量分析报告；模糊店铺名先按 [store-resolve.md](store-resolve.md) 解析规范店铺名：

```text
lxeskill replenish sales analyze --store-name "<规范店铺名>"
```

本地缺少对应店铺的 MSKU 源表或旧版源表缺少核验信息时，说明需先通过 `mabang-store-msku-export` 下载新版源表。

## 结果与报表字段

- 成功后调用 `send_files(paths=<terminal.files>)` 交付报告，同时说明源数据文件 `source_xlsx_path`、源数据时间 `source_data_time`、链接数（`link_count`）、ASIN 行数（`asin_count`）和 MSKU 行数（`msku_count`）。
- 报告包含 `链接销量前10`、`其他链接`、`ASIN销量前50`、`其他ASIN`、`MSKU明细` 5 个业务 Sheet，以及隐藏的 `源数据核验信息` Sheet（随源表传递核验信息）。
- 前 4 个聚合 Sheet 在 `加权日销` 前提供 `商品链接`：链接维度使用源表商品链接前缀拼接 `父ASIN`，ASIN 维度保留源表中的商品链接。
- 源表须包含新版 `源数据核验信息`。MSKU、ASIN、链接三个维度均汇总源表 XLSX 的全部记录（含库存和组合商品接口均未命中的记录）；商品类型绑定核验仅限制 V1 备货计算范围。
- `original_row_count`、`binding_verified_row_count`、`binding_unverified_row_count` 分别表示源表原始行数、绑定核验通过行数、未通过行数；`msku_count` 为参与销量分析的总行数。
- `data_is_stale=true` 时向用户说明源数据时间；用户明确要求最新数据时再重新下载源表。
- 重复 MSKU 逐行分析并保留，聚合表会累计各行销量；交付时转述 `data.warnings` 中的重复累计提示。其他输入错误保留真实原因。
