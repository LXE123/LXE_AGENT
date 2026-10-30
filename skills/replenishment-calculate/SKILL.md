---
name: replenishment-calculate
description: Amazon备货V1单步计算能力，基于本地销量分析报告、深圳真实库存报告和同日货件快照，保留原参数方案、算法和多Sheet报表。完整任务、版本选择和交付由 replenishment-workflow-map 编排；已有合格输入可按本Skill复算。
type: replenishment
commands:
  - lxeskill replenish calculate
references:
  - references/report.md
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# Amazon 备货V1计算

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 本地输入、来源或参数核验失败时说明实际错误与恢复所需输入；文件占用时提示关闭对应文件后重试。
- 完整备货由 `replenishment-workflow-map` 继续。独立单步只执行本步骤；有附件时使用 `send_files(paths=<terminal.files>)` 交付，发送失败只重试交付。

## 使用与命令

本Skill负责V1（普通备货）的计算。完整任务由 `replenishment-workflow-map` 按已确定版本安排；明确只用已有合格输入重算时执行本步骤，版本与其他步骤均返回主入口处理。

输入规范店铺名、本轮货件快照及可选参数方案；销量与深圳报告沿用原CLI按店铺选择并核验的方式。参数方案默认“默认”，用户指定时沿用。

```text
lxeskill replenish calculate --store-name "<规范店铺名>" --unlinked-shipments-snapshot "<本轮快照路径>" [--template "<参数方案名>"]
```

用户明确使用已有数据时可省略快照参数，CLI 自动查找同日快照；不意味着完整任务可以省略本轮货件查询。亚马逊对照输入仅用户明确要求时传 `--amazon-restock-inventory-snapshot "<路径>"`，先读对应 snapshot Skill。

## 前置与停止条件

- 销量与深圳库存必须具有同一源时间、同一源数据核验版本、源指纹和快照。日期相同并不足够。旧 Active 范围报表不能与新版全量报表混用。
- 完整任务缺前置数据时按流程补齐；单步任务缺输入时说明原因和下一步，不扩展范围。核验失败后必须基于同一源表重建相关报告。
- 完整任务必须持有本轮有效货件快照；查询失败停止正式建议，确认零货件快照则正常扣减 0。
- 直接计算的兼容行为允许缺快照时生成带提醒的试算；出现 `unlinked_shipments_snapshot_warning` 必须明确其局限，不能称为已完整核验的执行建议。完整任务先补齐快照再计算，不能在“缺快照→下载→仍缺快照”之间循环。

## 口径与交付

- 参数方案决定理论算法，随后 CLI 扣马帮 FBA 总库存及未关联货件；不再次手工扣减。海运无重量门槛，最小件数等现有条件仍生效。
- 首张“最终备货意见”仅含生成时建议发货且最终数量大于零的记录，不含清货、样本不足和暂不建议发货，无人工确认列。深圳库存不足仍展示建议及缺口，不代表已分配库存。
- 黄色输入可修改、蓝色公式自动重算；运输方式和日销分档不在 Excel 重新判断。详细 Sheet 是生成时快照，不联动；数量归零保留行，使用表头筛选排序。公式直接引用本行单元格，权重和海运最低件数直接写入公式，不再有隐藏记录标识或公式参数页。
- 所有 Sheet（含隐藏页）列宽 15、行高 15 磅，长文字可能显示不全但内容保留。
- 最终发送 terminal `files`，发送成功后说明源时间、方案版本、原始/核验通过/未通过范围、建议分类及货件确认情况。`row_count` 是计算输出行数，不等于首张表的建议发货行数。
- 详细字段、库存公式和成功/失败返回示例按需读 [references/report.md](references/report.md)。
