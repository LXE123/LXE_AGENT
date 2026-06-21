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

- 默认计算命令：`uv run --frozen python -m services.agent_cli.mabang.calculate_store_msku_replenishment --store-name "<店铺名>" [--template "<参数方案名>"]`
- 本 skill 只负责调用计算 CLI；报表匹配、计算和写出都由 CLI 完成。
- 销量分析报告和真实库存报告是必需输入；如果 CLI 提示缺少同源报表，路由到对应 skill。
- 参数方案只决定理论算法结果：补货天数、理论补货量、运输方式、海运/同时空运拆分。
- 计算 CLI 会在参数方案理论量基础上固定扣减 `FBA 总库存（马帮数据）` 和同日未关联货件，生成最终执行建议量。
- CLI 会自动查找与备货数据同日的未关联货件快照。
- 亚马逊补充库存 snapshot 是可选对照增强；只有用户明确要求使用亚马逊侧 FBA 库存扣减时，先用 `replenishment-amazon-restock-inventory-snapshot` 生成 snapshot，再把路径传给计算 CLI。
- 如果 CLI 返回未关联快照提醒，路由到 `replenishment-unlinked-shipment-download` 后重算。
- 如果用户给的是模糊店铺名，先运行 `replenishment-store-resolve`，用解析成功返回的规范 `store_name` 再计算。
- 只读取 CLI 输出的最后一行 JSON。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文。

## How to Execute

如果店铺名不确定，先解析店铺：

```powershell
uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store --store-name "<店铺名>"
```

解析成功后，用规范 `store_name` 生成备货建议。不指定参数方案时使用 `默认`：

```powershell
uv run --frozen python -m services.agent_cli.mabang.calculate_store_msku_replenishment --store-name "<店铺名>"
```

如果用户指定参数方案：

```powershell
uv run --frozen python -m services.agent_cli.mabang.calculate_store_msku_replenishment --store-name "<店铺名>" --template "<参数方案名>"
```

如果用户明确要求使用亚马逊补充库存扣减字段：

```powershell
uv run --frozen python -m services.agent_cli.mabang.calculate_store_msku_replenishment --store-name "<店铺名>" --amazon-restock-inventory-snapshot "<亚马逊补充库存snapshot.xlsx>"
```

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-Lerxiuer-FR",
  "source_data_time": "202605251530",
  "template_name": "默认",
  "template_version": 1,
  "row_count": 120,
  "link_count": 18,
  "air_urgent_count": 10,
  "air_count": 18,
  "sea_count": 35,
  "no_ship_count": 42,
  "sample_insufficient_count": 15,
  "report_xlsx_path": "artifacts/mabang_store_msku_replenishment/202605251530-Amazon-Lerxiuer-FR_备货建议.xlsx",
  "unlinked_shipments_snapshot_path": "artifacts/mabang_fba_unlinked_shipments_snapshots/202605251735-Amazon-Lerxiuer-FR_未关联货件快照.xlsx",
  "amazon_restock_inventory_snapshot_path": "artifacts/amazon_restock_inventory_snapshots/202605251735-Amazon-Lerxiuer-FR_亚马逊补充库存快照.xlsx",
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

- 必需：同一 `source_data_time` 的销量分析报告和真实库存报告。
- 参数方案阶段：先按指定参数方案算出理论 `补货量` 和运输建议。
- 固定扣减阶段：再扣 `FBA 总库存（马帮数据）` 和同日未关联货件，得到主执行建议量。
- 自动增强：同日未关联货件快照；找不到时 CLI 仍会生成备货建议，但结果里会返回提醒。
- 手动对照增强：亚马逊补充库存 snapshot；需要用户明确提供路径，日期允许和备货数据同日或相邻 `1` 个自然日。
- 参数方案可选：不传 `--template` 时使用 `默认`。

## Result Handling

- `success=true`：告诉用户备货建议已生成，并提供 `report_xlsx_path`。
- 同时说明 `source_data_time`、MSKU 行数、链接数，以及各运输方式行数。
- 同时说明使用的 `template_name` 和 `template_version`。
- 如果返回 `unlinked_shipments_snapshot_path`，说明本次已自动扣减同日未关联货件，并列出该路径。
- 如果返回 `unlinked_shipments_snapshot_warning`，必须转述提醒，并建议先运行未关联货件下载 skill 后重算。
- 如果返回 `amazon_restock_inventory_snapshot_path`，说明本次已加入亚马逊补充库存扣减字段，并列出该路径和 `amazon_restock_inventory_validation` 摘要。
- 结果文件固定包含 8 个 sheet：`空运（急发）`、`空运`、`海运`、`真实库存不足`、`清货`、`暂不建议发货`、`链接备货汇总`、`样本不足`。
- 传入亚马逊补充库存 snapshot 时，提醒用户结果里会额外展示亚马逊补充库存扣减字段。
- `success=false`：只转述 `exception`，不要猜测本地文件路径或自动补跑前置 skill。
