---
name: replenishment-sales-analyze
description: 基于本地已下载的马帮 Amazon 店铺 MSKU 数据生成销量分析报告。用户要求分析某个店铺的链接销量、ASIN销量、MSKU销量趋势、补货前销量趋势报告或“xxx店铺销量分析报告”时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
commands:
  - lxeskill replenish sales analyze
---

## When to Use

- 用户要生成某个马帮 Amazon 店铺的 MSKU 销量分析报告。
- 用户关注链接维度、ASIN 维度、MSKU 明细的销量趋势。
- 用户已经下载过店铺 MSKU 数据，需要从本地最新文件生成分析报告。

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI：`lxeskill replenish sales analyze --store-name "<店铺名>"`
- 不要手动读取或改写马帮接口请求。
- 不要自动下载最新 MSKU 数据；本 skill 只分析本地已下载文件。
- 如果本地没有店铺 MSKU 数据文件，提示用户先运行 `replenishment-msku-download`。
- 如果用户给的是模糊店铺名，先运行 `replenishment-store-resolve`，用解析成功返回的规范 `store_name` 再分析。
- 只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。
- CLI 失败时只转述 terminal 的 `error.message`；需要定位阶段时可读取 `data.context`。

## How to Execute

如果店铺名不确定，先解析店铺：

```text
lxeskill replenish store resolve --store-name "<店铺名>"
```

解析成功后，用规范 `store_name` 生成销量分析报告：

```text
lxeskill replenish sales analyze --store-name "<店铺名>"
```

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-Lerxiuer-FR",
  "source_xlsx_path": "artifacts/replenish/store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
  "source_data_time": "202605251530",
  "data_is_stale": true,
  "link_count": 18,
  "asin_count": 72,
  "msku_count": 180,
  "report_xlsx_path": "artifacts/replenish/sales_analysis/202605251530-Amazon-Lerxiuer-FR_销量分析.xlsx",
  "source": "mabang_store_msku_sales_analysis"
}
```

失败时：

```json
{
  "success": false,
  "store_name": "Amazon-Lerxiuer-FR",
  "exception": "未找到本地店铺MSKU数据文件: Amazon-Lerxiuer-FR"
}
```

## Result Handling

- `success=true`：告诉用户报告已生成，并提供 `report_xlsx_path`。
- 同时说明源数据文件 `source_xlsx_path`、源数据时间 `source_data_time`、链接数、ASIN 表行数和 MSKU 数。
- 报告包含 `链接销量前10`、`其他链接`、`ASIN销量前50`、`其他ASIN`、`MSKU明细` 5 个 sheet。
- 前 4 个聚合 sheet 在 `加权日销` 前提供 `商品链接`；链接维度会用源数据商品链接前缀拼接 `父ASIN`，ASIN 维度保留源数据里的商品链接。
- ASIN 表按 `ASIN + 父ASIN + MSKU` 售卖项粒度输出；如果源数据存在完全重复售卖项，CLI 会失败并提示重复键。
- `data_is_stale=true`：明确提醒用户这份报告基于非当天下载的数据；如需最新结果，应先运行店铺 MSKU 下载 skill。
- `success=false`：只转述 `exception`，不要猜测本地文件路径或自动下载。
