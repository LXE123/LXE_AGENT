---
name: replenishment-calculate
description: 基于本地销量分析报告、真实库存报告和同日未关联货件快照生成马帮 Amazon 店铺 MSKU 备货建议。用户要求计算某个店铺的备货量、补货量、运输方式、链接备货汇总或“xxx店铺备货建议/补货建议”时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
---

## When to Use

- 用户要基于已经生成的销量分析报告和真实库存报告，计算店铺 MSKU 备货建议。
- 用户要把 MSKU 分到 `空运（急发）`、`空运`、`海运`、`暂不建议发货`、`样本不足`。
- 用户要查看每个父 ASIN 链接的总备货量和涉及运输方式。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.calculate_store_msku_replenishment --store-name "<店铺名>" [--template "<模板名>"]`
- 不要手动读取、合并或改写报表生成逻辑；报表匹配、计算和写出都由 CLI 完成。
- 不要自动下载店铺 MSKU 数据。
- 不要自动生成销量分析报告或真实库存报告；如果 CLI 提示缺少同源报表，告诉用户先运行对应 skill。
- CLI 会自动查找与备货数据同日的未关联货件快照。
- 不要自动下载未关联货件；如果 CLI 返回未关联快照提醒，提示用户先运行 `replenishment-unlinked-shipment-download` 后重算。
- 如果用户给的是模糊店铺名，先运行 `replenishment-store-resolve`，用解析成功返回的规范 `store_name` 再计算。
- 只读取 CLI 输出的最后一行 JSON。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文。

## How to Execute

如果店铺名不确定，先解析店铺：

```powershell
uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store --store-name "<店铺名>"
```

解析成功后，用规范 `store_name` 生成备货建议。不指定模板时使用 `默认模板`：

```powershell
uv run --frozen python -m services.agent_cli.mabang.calculate_store_msku_replenishment --store-name "<店铺名>"
```

如果用户指定模板：

```powershell
uv run --frozen python -m services.agent_cli.mabang.calculate_store_msku_replenishment --store-name "<店铺名>" --template "<模板名>"
```

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-Lerxiuer-FR",
  "source_data_time": "202605251530",
  "template_name": "默认模板",
  "template_version": 1,
  "row_count": 120,
  "link_count": 18,
  "air_urgent_count": 10,
  "air_count": 18,
  "sea_count": 35,
  "no_ship_count": 42,
  "sample_insufficient_count": 15,
  "report_xlsx_path": "artifacts/mabang_store_msku_replenishment/202605251530-Amazon-Lerxiuer-FR_replenishment.xlsx",
  "unlinked_shipments_snapshot_path": "artifacts/mabang_fba_unlinked_shipments_snapshots/202605251735-Amazon-Lerxiuer-FR_unlinked_shipments_snapshot.xlsx",
  "source": "mabang_store_msku_replenishment"
}
```

失败时：

```json
{
  "success": false,
  "store_name": "Amazon-Lerxiuer-FR",
  "exception": "未找到同源时间的销量分析和真实库存报表: store=Amazon-Lerxiuer-FR, sales_times=..., inventory_times=..."
}
```

## Input Requirements

- 销量分析报告来自 `artifacts/mabang_store_msku_analysis/`，文件名形如 `<source_data_time>-<store_name>_sales_analysis.xlsx`。
- 真实库存报告来自 `artifacts/mabang_store_msku_inventory/`，文件名形如 `<source_data_time>-<store_name>_actual_inventory.xlsx`。
- 两个输入报表必须有相同的 `source_data_time`，避免混用不同时间的数据。
- 未关联货件快照来自 `artifacts/mabang_fba_unlinked_shipments_snapshots/`，文件名形如 `<snapshot_time>-<store_name>_unlinked_shipments_snapshot.xlsx`。
- CLI 只会使用 `snapshot_time[:8] == source_data_time[:8]` 的同日快照；同日多个快照时自动使用时间最新的一个。
- 销量分析读取 `MSKU明细` 中的 `销量趋势` 和 `单品重量(g)(cm)`。
- 真实库存读取 `真实库存-组合sku` 和 `真实库存-库存sku`。

## Result Handling

- `success=true`：告诉用户备货建议已生成，并提供 `report_xlsx_path`。
- 同时说明 `source_data_time`、MSKU 行数、链接数，以及各运输方式行数。
- 同时说明使用的 `template_name` 和 `template_version`。
- 如果返回 `unlinked_shipments_snapshot_path`，说明本次已自动扣减同日未关联货件，并列出该路径。
- 如果返回 `unlinked_shipments_snapshot_warning`，必须转述提醒，并建议先运行未关联货件下载 skill 后重算。
- 结果文件固定包含 6 个 sheet：`链接备货汇总`、`空运（急发）`、`空运`、`海运`、`暂不建议发货`、`样本不足`。
- `链接备货汇总` 按 `父ASIN` 聚合，并按 `总补货量` 降序；样本不足行也会进入汇总展示，但不计入总补货量。
- `链接备货汇总` 的 `商品链接` 会从组内首个可解析原始链接提取 URL 前缀，再拼接 `父ASIN`，例如 `http://www.amazon.com/gp/product/` + `B0PARENTXX`。
- `链接备货汇总` 最后一列是 `链接真实本地库存汇总`，按 `父ASIN` 汇总各 MSKU 的真实本地库存数量。
- 明细 sheet 使用已有的 `真实库存数量`，不重复追加同义库存列。
- 明细 sheet 包含 `补货天数`、`补货量`、`海运天数`、`海运建议量`、`预计总重量kg` 和 `决策原因`。
- 明细 sheet 还包含 `模板名称` 和 `命中规则`，用于追溯每个 MSKU 使用的参数规则。
- `success=false`：只转述 `exception`，不要猜测本地文件路径或自动补跑前置 skill。
