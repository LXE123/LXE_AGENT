---
name: replenishment-workflow-map
description: Amazon备货唯一完整编排入口，按用户意图生成V1普通备货、V2备货或两种版本。复用同轮马帮数据，分别调用对应计算并独立检查、交付；版本不明确时结合上下文判断，仍不明确才确认一次。
type: replenishment
commands:
  - lxeskill replenish v2 generate
---

# Amazon 备货

## 用途

统一负责 Amazon 备货的版本选择、取数、计算和交付。V1沿用原算法及多Sheet报表；V2使用14个公式字段生成35列单工作表。用户可要求一个版本或同时要求两种。

| 版本 | 产物 |
|---|---|
| V1普通备货 | 原参数方案和算法生成的多Sheet报表。 |
| V2备货 | `replenish v2 generate` 生成的35列 `mskulist` 工作表。 |

## 输入

- 必需：Amazon店铺名及目标版本（V1、V2或两种）。“普通备货”对应V1，“两种都要”对应同时生成V1和V2。
- 可选：V1参数方案，默认“默认”；V2旺季加成和天数，页面初始关闭，未提旺季时使用页面设置，本轮聊天明确要求优先。
- 明确指定V1、V2或两种时直接沿用，不重复确认。版本不明确时先结合本轮上下文判断；仍无法确定时只询问一次，并等待明确回答。
- 模糊店铺名交给店铺解析能力核对真实候选；平台或业务不明确时确认业务。

## 依赖

共用 `replenishment-store-resolve`、`mabang-store-msku-export`、`mabang-store-shenzhen-inventory-export` 和 `mabang-store-unlinked-shipments-export`。V1另使用 `replenishment-sales-analyze`；V2由工作簿公式计算销量趋势。V1参数方案由 `replenishment-algorithm-config-manage` 管理，Seller Central可选库存对照由 `replenishment-amazon-restock-inventory-snapshot` 提供。

调用前读取对应取数Skill；V1计算读取 `replenishment-calculate`，V2生成命令由本Skill提供。运行前用 `lxeskill list` 和 `lxeskill describe <命令路径>` 查询当前公开参数；文件发送使用 `send_files`。

## 执行

完整任务默认采集本轮数据；当前任务已有同轮合格输入时复用，并只补缺失或不匹配的数据。双版本共用同一轮已核验MSKU、深圳报告和货件快照，各取一次；V1另生成销量报告，V2不依赖该报告。

| 顺序 | 能力与调用 | 输出交接 |
|---|---|---|
| 1 | `replenishment-store-resolve`：`lxeskill replenish store resolve --store-name "<用户店铺名>"` | 保留规范 `store_name`、`store_id`、`id_type`；候选有歧义时请用户选择。 |
| 2 | `mabang-store-msku-export`：`lxeskill mabang store msku export --store-id "<store_id>" --id-type "<id_type>" --store-name "<规范店铺名>"` | 保留本轮 `data.xlsx_path` 及行数；源时间由后续同源报告交叉核对。 |
| 3，仅V1或双版本 | `replenishment-sales-analyze`：`lxeskill replenish sales analyze --store-name "<规范店铺名>"` | 保留 `data.report_xlsx_path`、`source_xlsx_path`、`source_data_time`；确认来源为步骤2的本轮源表。 |
| 4 | `mabang-store-shenzhen-inventory-export`：`lxeskill mabang store shenzhen-inventory export --store-name "<规范店铺名>" --msku-source-xlsx-path "<步骤2源表路径>"` | 保留 `data.shenzhen_warehouse_inventory_report_xlsx_path`、`source_msku_xlsx_path`、`source_msku_data_time`；调用步骤5前核对其来源指向步骤2本轮文件。 |
| 5 | `mabang-store-unlinked-shipments-export`：`lxeskill mabang store unlinked-shipments export --store-name "<规范店铺名>"` | 确认三类状态均成功；保留快照路径和 `confirmed_empty`。已确认的空快照按0货件处理。 |
| 6 | 按下表分别运行所需版本 | 每版保留自己的命令终态、结果文件和错误。 |
| 7 | 对每版检查通过的文件执行 `send_files(paths=<该版terminal.files>)` | 独立交付并分别记录发送结果。 |

| 版本 | 计算调用与交接 |
|---|---|
| V1 | 读取 `replenishment-calculate` 后运行：`lxeskill replenish calculate --store-name "<规范店铺名>" --unlinked-shipments-snapshot "<步骤5快照路径>" [--template "<方案名>"]`。V1按原CLI读取并核验销量和深圳报告；核对返回的 `sales_analysis_xlsx_path`、`actual_inventory_xlsx_path`、`source_data_time` 属于本轮步骤3、4。 |
| V2 | 本Skill运行：`lxeskill replenish v2 generate --store-name "<规范店铺名>" --msku-source-xlsx-path "<步骤2源表路径>" --shenzhen-inventory-report-xlsx-path "<步骤4深圳报告路径>" --unlinked-shipments-snapshot-path "<步骤5快照路径>" [--peak-boost-enabled] [--peak-boost-days <0～120>]`。未提旺季时省略两个参数，沿用页面保存的开关和天数。聊天明确开启时传裸开关 `--peak-boost-enabled`，明确关闭时传 `--peak-boost-enabled=false`；聊天指定天数时传 `--peak-boost-days <0～120>`，单独指定天数即启用，明确关闭仍优先。启用没有默认天数；若命令报告缺少天数，询问用户后复用本轮数据重算。本轮覆盖不改写页面设置。 |

V2使用同轮MSKU、深圳库存报告和货件快照，核验来源指纹、店铺、批次及MSKU覆盖。生成 `mskulist` 工作表的35列和全部MSKU行，每行写入14个公式字段，包括I“销量趋势”、J“加权日销”和AI“可供天数”；商品类型核验未通过的行也保留。

V2的AG“本地库存”读取深圳报告的“真实库存（深圳仓库）数量”。普通SKU及组合SKU沿用该报告已有的匹配和组件配比计算结果；正数、真实0和有限负数按报告保留，`uq122`不作为来源或必需输入。深圳库存未知时AG留空，仍保留所有MSKU及公式，生成带“库存待核对”的文件并返回 `success=false`、terminal `ok=false`；`data.unknown_inventory_examples`用于运营核对。这是运营确认前的临时规则，只供核对，不作V2正式交付。AH、AD、AI及空海运公式沿用现有计算规则，不新增AG扣减。

## 结果

- 读取每步最后一条 `type="result"`；运行中等待原会话。共用取数、认证或来源失败时，停止依赖该输入的版本；`ok=false`时保留实际错误及已有诊断文件。双版本中的独立计算或交付失败不覆盖另一版结果。
- V1保留原核验、过滤规则和多Sheet产物。销量分析或V1计算失败仅停止V1；若已选择V2且共享输入合格，继续V2必要的共享取数、全MSKU计算及检查。V2未知库存或计算失败也不阻止已满足前提的V1计算和正式交付；此临时规则不影响V1。
- V2完成Office Kit重算、35列和14公式检查及Excel错误检查后，检查 `data.output_xlsx_path`、公式错误数、源数据时间和terminal `files`。只有terminal `ok=true`、`data.formula_error_count=0`、来源检查和Office Kit均通过，才进入正式交付；失败附件只作诊断。认证、来源或Office失败时保留真实错误并停止。
- 各版本只有自身数据、计算和检查通过，且文件实际发送成功，才算该版本正式交付。分别说明V1/V2产物、来源时间、交付状态及失败原因；不把一版成功称为两版全部成功。发送失败只重试该版文件交付。
