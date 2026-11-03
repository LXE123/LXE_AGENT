---
name: replenishment-workflow-map
description: Amazon备货统一入口，复用同轮马帮数据，通过同一个命令的版本参数生成V1、V2或分别生成两版。负责店铺确认、数据准备、计算检查和文件交付。
type: replenishment
commands:
  - lxeskill replenish calculate
references:
  - references/report.md
---

# Amazon 备货

## 输入与版本

- 输入店铺和目标版本。普通备货对应 V1；两种都要时使用同一组文件分别生成 V1、V2。明确的店铺、版本沿用上下文，不重复确认；版本仍不明确时询问一次。
- 单店单站点以 MSKU 标识售卖项。每条源记录使用自己的销量和库存分项计算，按 MSKU 对应货件，本地 SKU 关联仓库商品；ASIN、父 ASIN 用于展示与汇总。重复 MSKU 仍逐行计算、保留各行，交付时转述 `data.warnings` 中“数量可能重复累计”的提示。
- V1 使用原参数方案、筛选和多 Sheet 报表，参数方案默认“默认”。V2 保留全部 MSKU，使用 14 个公式生成 35 列 `mskulist`。
- V2 旺季设置由桌面保存，聊天明确要求优先且只影响本轮；初始关闭，开启须提供 0～120 的整数天数。

## 公共数据准备

完整任务默认获取本轮数据；用户指定使用已有数据，或本任务已有同轮合格文件时复用，只补缺失或不匹配的输入。双版本各项数据只获取一次。

调用数据能力前读取对应 Skill，通过 `lxeskill list` 和 `lxeskill describe <命令路径>` 查询契约。产物目录通过 `lxeskill datasets list` 查询，返回的 `dir` 相对于当前环境的 `artifact_root`。

| 顺序 | 公共能力 | 保留的结果 |
|---|---|---|
| 1 | `replenishment-store-resolve`：`lxeskill replenish store resolve --store-name "<店铺名>"` | 单站点规范 `store_name`、`store_id`、`id_type`。 |
| 2 | `mabang-store-msku-export`：`lxeskill mabang store msku export --store-id "<ID>" --id-type "<类型>" --store-name "<店铺>"` | `data.xlsx_path`，作为两版共同的 MSKU 源表。 |
| 3 | `mabang-store-shenzhen-inventory-export`：`lxeskill mabang store shenzhen-inventory export --store-name "<店铺>" --msku-source-xlsx-path "<步骤2文件>"` | `data.shenzhen_warehouse_inventory_report_xlsx_path`；核对 `source_msku_xlsx_path` 指向步骤2文件。 |
| 4 | `mabang-store-unlinked-shipments-export`：`lxeskill mabang store unlinked-shipments export --store-name "<店铺>"` | 三类状态均成功的快照路径及 `confirmed_empty`。确认空快照时正常按 0 货件计算。 |

尚未确定店铺时，先不带名称执行店铺解析，读取 `data.xlsx_path` 的真实店铺列表。按国家、站点和名称筛选后，用 `ask_user_question` 确认单站点，每题最多4个选项；候选多时先选父级店铺组，同名项用父级名称或ID区分。

## 统一计算

```text
lxeskill replenish calculate --version <v1或v2> --store-name "<店铺>" --msku-source-xlsx-path "<步骤2文件>" --shenzhen-inventory-report-xlsx-path "<步骤3文件>" --unlinked-shipments-snapshot-path "<步骤4文件>"
```

三份文件必须明确传入。命令离线读取、校验和计算，不自动寻找文件或重新获取数据；V1 在内部完成销量分析，不需要先执行销量分析命令。双版本使用完全相同的三个路径分别调用，等待各自原会话结束。

- V1 可传 `--template "<方案名>"`，方案管理使用 `replenishment-algorithm-config-manage`。用户明确要求亚马逊库存对照时，先读取 `replenishment-amazon-restock-inventory-snapshot`，再传已有的 `--amazon-restock-inventory-snapshot` 或 `--amazon-fba-inventory-snapshot`；对照不改变默认执行建议。
- V2 未提旺季时省略旺季参数；明确开启传 `--peak-boost-enabled`，关闭传 `--peak-boost-enabled=false`；指定天数传 `--peak-boost-days <0～120>`。单独指定天数即启用，明确关闭优先。启用缺天数时询问用户，补充后复用原文件重算。
- 版本专用参数仅传给对应版本。来源指纹、店铺、批次和货件日期校验失败时保留实际错误，基于同一源表补齐输入。

## 检查与交付

- 每次读取最后一条 `type="result"`，先看 `ok`，再检查 `data.version`、`source_data_time` 和三个实际输入路径。输出统一为 `data.output_xlsx_path`，通过 `send_files(paths=<terminal.files>)` 发送。
- 共用输入失败时停止依赖它的版本；单方计算或发送失败不覆盖另一版结果。发送失败只重试该版交付，计算重试复用已确认的输入。只有该版检查通过且文件发送成功，才算完成交付。
- V1 沿用绑定核验、商品筛选、参数计算和库存扣减；首张表仅展示最终建议发货的记录，其他页为生成时快照。黄底输入可修改、蓝底公式重算；运输方式及分档不重新判断。报表字段见 [报表参考](references/report.md)。
- V2 保留全部 MSKU，包括绑定核验未通过的行。AG 本地库存沿用深圳报告的普通/组合 SKU 结果，保留正数、0和有限负数；未知时留空，不额外扣减 AG。Office 重算和公式检查通过后，库存未知仍交付带“库存待核对”标记的文件，说明 `unknown_inventory_count` 和代表项。
- V2 来源不一致、Office 失败或公式错误时不算成功；保留实际错误，失败附件仅供诊断。文件发布失败不覆盖已有合格产物。
- 两版各工作表列宽15、行高15磅。分别说明来源时间、行数、交付状态和待核对事项。
