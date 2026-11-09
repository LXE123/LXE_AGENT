---
name: amazon-replenishment
description: Amazon 备货统一技能：负责马帮 Amazon 店铺名称与网页 ID 解析、V1/V2 备货数据准备与计算交付、店铺销量分析报告生成、V1 备货算法参数方案管理。明确的越南备货使用 vietnam-replenishment；东南亚范围导航见 southeast-asia-replenishment-workflow-map；按 SP 发货单或退税总表生成 FBA 采购/备货单使用 fba-workflow-map。
type: replenishment
commands:
  - lxeskill replenish calculate
  - lxeskill replenish store resolve
  - lxeskill replenish sales analyze
  - lxeskill replenish template
references:
  - references/report.md
  - references/store-resolve.md
  - references/sales-analyze.md
  - references/algorithm-config-manage.md
---

# Amazon 备货

## 范围与任务分流

- 本 Skill 用于马帮 Amazon 店铺备货及配套能力。明确的越南备货读取 `vietnam-replenishment`（东南亚导航见 `southeast-asia-replenishment-workflow-map`）；按 `SP...` 发货单号或出口退税总表生成采购汇总/备货单读取 `fba-workflow-map`。用户只说“备货”且无法判断业务模块时，先确认业务范围；仅询问流程时直接解释，不执行命令。
- **单步能力按需读取对应参考并只执行该步骤**（成功后按返回数据答复；`terminal.files` 非空时调用 `send_files` 交付文件，不自动扩展为完整备货）：
  - 解析店铺名称、查询网页 ID 或列出候选店铺：见 [references/store-resolve.md](references/store-resolve.md)
  - 独立生成店铺链接/ASIN/MSKU 销量分析报告：见 [references/sales-analyze.md](references/sales-analyze.md)
  - 查看、导出、校验、导入或管理 V1 备货算法参数方案：见 [references/algorithm-config-manage.md](references/algorithm-config-manage.md)
- **完整备货任务（V1 / V2）**：输入店铺和目标版本。普通备货对应 V1；两种都要时复用同一组输入文件分别生成 V1、V2。明确的店铺、版本沿用上下文，不重复确认；版本不明确时询问一次。
- 单店单站点以 MSKU 标识售卖项。每条源记录使用自身销量和库存分项计算，按 MSKU 对应货件，本地 SKU 关联仓库商品；ASIN、父 ASIN 用于展示与汇总。重复 MSKU 逐行计算并保留，交付时转述 `data.warnings` 中“数量可能重复累计”的提示。
- 两版均以 MSKU 源表为计算范围，匹配的货件正常扣减；快照中源表外的 MSKU 不参与计算、不阻断生成。交付时转述 `data.warnings` 中未匹配 MSKU 数、货件数量与示例，完整记录保留在原快照中。
- V1 使用参数方案（默认“默认”）、绑定与已知库存筛选及三表模板；V2 保留全部 MSKU，使用 14 个公式生成 35 列 `mskulist`。
- V2 旺季设置由桌面保存（初始关闭，开启须提供 0～120 的整数天数）；聊天明确要求优先且只作用于本轮。

## 公共数据准备

完整备货任务默认获取本轮数据；用户指定使用已有数据，或本任务已有同轮合格文件时直接复用，只补缺失或不匹配的输入。双版本共用同一轮数据，各步骤只采集一次。

调用外部导出能力前读取对应导出 Skill，通过 `lxeskill list` 和 `lxeskill describe <命令路径>` 查询契约。产物目录通过 `lxeskill datasets list` 查询，返回的 `dir` 相对于当前环境的 `artifact_root`。

| 顺序 | 公共步骤 | 保留的结果 |
|---|---|---|
| 1 | 店铺解析：`lxeskill replenish store resolve --store-name "<店铺名>"`（详见 [store-resolve.md](references/store-resolve.md)） | 单站点规范 `store_name`、`store_id`、`id_type`。未指定或有歧义时筛选真实候选并由用户确认单站点。 |
| 2 | `mabang-store-msku-export`：`lxeskill mabang store msku export --store-id "<ID>" --id-type "<类型>" --store-name "<店铺>"` | `data.xlsx_path`，作为两版共同的 MSKU 源表。 |
| 3 | `mabang-store-shenzhen-inventory-export`：`lxeskill mabang store shenzhen-inventory export --store-name "<店铺>" --msku-source-xlsx-path "<步骤2文件>"` | `data.shenzhen_warehouse_inventory_report_xlsx_path`；核对 `source_msku_xlsx_path` 指向步骤 2 文件。 |
| 4 | `mabang-store-unlinked-shipments-export`：`lxeskill mabang store unlinked-shipments export --store-name "<店铺>"` | 三类状态均查询成功的 `data.snapshot.snapshot_xlsx_path` 及 `confirmed_empty`（`confirmed_empty=true` 为有效零货件快照，正常按 0 扣减）。 |

若步骤 2 源表全部记录均未通过绑定核验（`binding_verified_row_count=0`），步骤 3 仍会生成包含异常明细的深圳库存报告；此时 V1 因无可计算记录停止（可交付已生成的源表与深圳库存报告），不阻断已授权的 V2 继续执行步骤 4 与计算。

## 统一计算

```text
lxeskill replenish calculate --version <v1或v2> --store-name "<店铺>" --msku-source-xlsx-path "<步骤2文件>" --shenzhen-inventory-report-xlsx-path "<步骤3文件>" --unlinked-shipments-snapshot-path "<步骤4文件>"
```

三份文件路径必须显式传入。命令离线读取、校验和计算，不自动查找文件或重新采集；V1 在内部完成销量计算，无需先运行销量分析命令。双版本使用完全相同的三个路径分别调用，等待各自会话结束。

- **V1 可选参数**：可传 `--template "<方案名>"`（方案管理见 [algorithm-config-manage.md](references/algorithm-config-manage.md)）。
- **V2 可选参数**：未提旺季时省略；明确开启传 `--peak-boost-enabled`，明确关闭传 `--peak-boost-enabled=false`；指定天数传 `--peak-boost-days <0～120>`（单独指定天数即启用，明确关闭优先）。启用但缺天数时先询问用户，补充后复用原文件重算。
- 版本专用参数互斥，仅传给对应版本。来源指纹、店铺、批次或货件日期校验失败时保留实际错误，基于同一源表补齐输入。

## 检查与交付

- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，再核对 `data.version`、`source_data_time` 和三个实际输入路径；失败保留真实 `error.message` 和可用的 `data.context`。完整任务的中间采集文件不单独发送，最终输出统一取 `data.output_xlsx_path`，通过 `send_files(paths=<terminal.files>)` 交付。
- 共用输入失败时停止依赖它的版本；单方计算或发送失败不覆盖另一版结果。发送失败只重试交付，不重跑计算。只有检查通过且文件发送成功才算完成交付。
- **V1 结果**：仅对通过绑定核验且有已知深圳库存的记录计算建议；工作表结构、试算公式及字段含义见 [V1 报表参考](references/report.md)。
- **V2 结果**：保留全部 MSKU（含未通过绑定核验行）。AG 本地库存沿用深圳报告的普通/组合 SKU 结果（保留正数、0 和有限负数，不额外扣减 AG）；库存未知时 AG 留空，Office 重算和公式检查通过后照常交付带“库存待核对”标记的文件，并说明 `unknown_inventory_count` 和代表项。来源不一致、Office 失败或公式错误不算成功，失败附件仅供诊断。
- 文件名分别以 `备货建议-v1.xlsx`、`备货建议-v2.xlsx` 结尾；V2 的库存待核对或公式错误诊断标记放在版本后缀前。V1 各业务工作表第 1 行为字段名，第 2 行起为数据。两版各工作表列宽 15、行高 15 磅。交付后分别说明来源时间、行数、交付状态和待核对事项。
