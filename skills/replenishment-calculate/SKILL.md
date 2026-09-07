---
name: replenishment-calculate
description: 基于本地销量分析报告、真实库存（深圳仓库）报告和同日未关联货件快照生成马帮 Amazon 店铺 MSKU 备货建议。用户要求计算某个店铺的备货量、补货量、运输方式、链接备货汇总或“xxx店铺备货建议/补货建议”时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
commands:
  - lxeskill replenish calculate
---

## When to Use

- 用户要基于已经生成的销量分析报告和真实库存（深圳仓库）报告，计算店铺 MSKU 备货建议。
- 用户要把 MSKU 分到 `空运（急发）`、`空运`、`海运`、`暂不建议发货`、`样本不足`。
- 用户要查看每个父 ASIN 链接的总备货量和涉及运输方式。

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 默认计算命令：`lxeskill replenish calculate --store-name "<店铺名>" [--template "<参数方案名>"]`
- 本 skill 只负责调用计算 CLI；报表匹配、计算和写出都由 CLI 完成。
- 销量分析报告和真实库存（深圳仓库）报告是必需输入；如果 CLI 提示缺少同源报表，路由到对应 skill。
- 参数方案只决定理论算法结果：补货天数、理论补货量、运输方式、海运/同时空运拆分。
- 海运不再受最低重量或缺少单件重量限制；销量门槛、海运开关和最小件数等条件继续生效。重量只供物流参考。
- 计算 CLI 会在参数方案理论量基础上固定扣减 `FBA 总库存（马帮数据）` 和同日未关联货件，生成最终执行建议量。
- CLI 会自动查找与备货数据同日的未关联货件快照。
- 亚马逊补充库存 snapshot 是可选对照增强；只有用户明确要求使用亚马逊侧 FBA 库存扣减时，先用 `replenishment-amazon-restock-inventory-snapshot` 生成 snapshot，再把路径传给计算 CLI。
- 如果 CLI 返回未关联快照提醒，路由到 `replenishment-unlinked-shipment-download` 后重算。
- 如果用户给的是模糊店铺名，先运行 `replenishment-store-resolve`，用解析成功返回的规范 `store_name` 再计算。
- 只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。
- CLI 失败时只转述 terminal 的 `error.message`；需要定位阶段时可读取 `data.context`。

## How to Execute

如果店铺名不确定，先解析店铺：

```text
lxeskill replenish store resolve --store-name "<店铺名>"
```

解析成功后，用规范 `store_name` 生成备货建议。不指定参数方案时使用 `默认`：

```text
lxeskill replenish calculate --store-name "<店铺名>"
```

如果用户指定参数方案：

```text
lxeskill replenish calculate --store-name "<店铺名>" --template "<参数方案名>"
```

如果用户明确要求使用亚马逊补充库存扣减字段：

```text
lxeskill replenish calculate --store-name "<店铺名>" --amazon-restock-inventory-snapshot "<亚马逊补充库存snapshot.xlsx>"
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
  "report_xlsx_path": "artifacts/replenish/calculation/202605251530-Amazon-Lerxiuer-FR_备货建议.xlsx",
  "unlinked_shipments_snapshot_path": "artifacts/replenish/unlinked_shipments_snapshots/202605251735-Amazon-Lerxiuer-FR_未关联货件快照.xlsx",
  "amazon_restock_inventory_snapshot_path": "artifacts/replenish/restock_inventory_snapshots/202605251735-Amazon-Lerxiuer-FR_亚马逊补充库存快照.xlsx",
  "source": "mabang_store_msku_replenishment"
}
```

失败时：

```json
{
  "success": false,
  "store_name": "Amazon-Lerxiuer-FR",
  "exception": "未找到同源时间的销量分析和真实库存（深圳仓库）报表: store=Amazon-Lerxiuer-FR, sales_times=..., inventory_times=..."
}
```

## Input Requirements

- 必需：同一 `source_data_time` 的销量分析报告和真实库存（深圳仓库）报告。
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
- 结果文件包含 9 个业务 sheet：`最终备货意见`、`空运（急发）`、`空运`、`海运`、`真实库存（深圳仓库）不足`、`清货`、`暂不建议发货`、`链接备货汇总`、`样本不足`，另有隐藏的 `备货公式参数` 和 Active 核验信息。
- 优先查看首个 `最终备货意见`：只展示空运（急发）、空运、海运中最终建议数量大于零的记录，不含清货、暂不建议发货和样本不足，不设人工确认列。
- 简化表的空运、海运建议量已经扣减马帮 FBA 库存及本次取得的未关联货件，不要再次扣减。海运同时需要空运时，两列分别展示最终数量，运输方式为 `空运＋海运`；预计总重量包含两者，单件重量缺失时留空并注明。
- 简化表支持 Excel 公式试算：修改浅黄色的销量、库存、未发出货件总计、补货天数和重量，蓝色公式列自动重算。`未发出货件总计`就是本次取得的未关联货件数量，未取得快照时表内会注明需核实。
- FBA 总库存只合计可售、待入库、预留、在途、待调仓、调仓中；计划入库仅展示，不扣减。90 天销量仅展示，加权日销仍使用本轮参数方案的 7/14/30 天权重。
- 手动修改仅影响简化表；运输方式固定为生成时结果，天数可手改，但不自动重新匹配分档。原详细表是生成时快照。数量变为零时该行仍保留，排序使用表头筛选，不要删除隐藏的记录标识或公式参数。
- 深圳可用库存不足时仍保留算法建议量，在备注提示缺口；简化表不代表已按深圳库存分配或实际发货。品名优先使用本地 SKU 名称，商品备注和决策提示保留在备注列。没有建议发货记录时只保留表头。
- 传入亚马逊补充库存 snapshot 时，提醒用户结果里会额外展示亚马逊补充库存扣减字段。
- `success=false`：只转述 `exception`，不要猜测本地文件路径或自动补跑前置 skill。

## Active 来源一致性

- 销量与真实库存报表必须带有同一版本、同一源数据指纹和同一 Active 快照的核验信息，时间戳相同并不足以证明可混用。
- 旧版全量报表不能与新版 Active 报表混用；核验失败时，从同一份新下载源表重新生成销量与库存报表。
- 仅 Active 范围内且满足既有库存、绑定及算法条件的行进入建议。源表中的未确认在售记录不会因为仍有近期销量而重新进入计算。
- 返回的 `original_row_count`、`active_row_count`、`excluded_row_count` 描述源表范围；`row_count` 仍表示实际生成建议的行数。
