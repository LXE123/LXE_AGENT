---
name: replenishment-calculate
description: 基于本地销量分析报告、真实库存（深圳仓库）报告和同日未关联货件快照生成马帮 Amazon 店铺 MSKU 备货建议。用户要求计算某个店铺的备货量、补货量、运输方式、链接备货汇总或“xxx店铺备货建议/补货建议”时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
commands:
  - lxeskill replenish calculate
references:
  - references/report.md
---

# 备货计算与最终交付

## 执行与错误

- 通过 `exec` 调用本 Skill 声明的 CLI；不手工拼 API、不猜 ID 或凭据、不直接执行 Python 业务模块。
- 只把最后一条 `type="result"` 当作 terminal：先看 `ok`，业务字段读 `data`，附件读 `files`；失败保留 `error.message` 和相关 `data.context`，不把业务示例当成完整 terminal。
- 命令返回运行中/session running 时等待同一会话，不重复启动下载或导出。
- 只有 `data.auth_refresh_required=true` 才按 `lxeskill auth refresh` 的恢复流程刷新一次，再重试失败步骤；为 false 或缺失时停止并保留诊断，不凭错误文本中的 401/403 或 ID 猜测认证失败。
- 店铺歧义展示真实候选供选择；绑定冲突、分页异常、数据服务权限错误停止。文件占用时提示关闭对应文件后重试，不删除目标。
- 业务执行中不修改安装目录脚本、依赖或历史报表绕过错误；用户另行要求源码修复时按开发任务处理。
- 完整备货任务按 `replenishment-workflow-map` 连续推进；单步请求只执行指定步骤，缺前置数据时说明缺什么及下一步，不自行扩展为完整备货。
- 单步文件任务成功后调用 `send_files(paths=<terminal.files>)`；完整任务的中间文件保留，到最终计算完成才发送最终 terminal `files`。没有附件时不猜路径。发送成功才说已交付，发送失败只重试交付，不重跑业务。

## 使用与命令

完整备货请求先读 `replenishment-workflow-map`，自动完成本轮数据采集；明确只用已有输入重算时执行本步骤。参数方案默认“默认”，用户指定时沿用。

```text
lxeskill replenish calculate --store-name "<规范店铺名>" --unlinked-shipments-snapshot "<本轮快照路径>" [--template "<参数方案名>"]
```

用户明确使用已有数据时可省略快照参数，CLI 自动查找同日快照；不意味着完整任务可以省略本轮货件查询。亚马逊对照输入仅用户明确要求时传 `--amazon-restock-inventory-snapshot "<路径>"`，先读对应 snapshot Skill。

## 前置与停止条件

- 销量与深圳库存必须具有同一源时间、同一 Active 核验版本、源指纹和快照。日期相同并不足够。旧全量报告不能与 Active 报告混用。
- 完整任务缺前置数据时按流程补齐；单步任务缺输入时说明原因和下一步，不扩展范围。核验失败后必须基于同一源表重建相关报告。
- 完整任务必须持有本轮有效货件快照；查询失败停止正式建议，确认零货件快照则正常扣减 0。
- 直接计算的兼容行为允许缺快照时生成带提醒的试算；出现 `unlinked_shipments_snapshot_warning` 必须明确其局限，不能称为已完整核验的执行建议。完整任务先补齐快照再计算，不能在“缺快照→下载→仍缺快照”之间循环。

## 口径与交付

- 参数方案决定理论算法，随后 CLI 扣马帮 FBA 总库存及未关联货件；不再次手工扣减。海运无重量门槛，最小件数等现有条件仍生效。
- 首张“最终备货意见”仅含生成时建议发货且最终数量大于零的记录，不含清货、样本不足和暂不建议发货，无人工确认列。深圳库存不足仍展示建议及缺口，不代表已分配库存。
- 黄色输入可修改、蓝色公式自动重算；运输方式和日销分档不在 Excel 重新判断。详细 Sheet 是生成时快照，不联动；数量归零保留行，使用表格筛选排序，不删除隐藏记录标识或参数页。
- 所有 Sheet（含隐藏页）列宽 15、行高 15 磅，长文字可能显示不全但内容保留。
- 最终发送 terminal `files`，发送成功后说明源时间、方案版本、原始/Active/排除范围、建议分类及货件确认情况。`row_count` 是计算输出行数，不等于首张表的建议发货行数。
- 详细字段、库存公式和成功/失败返回示例按需读 [references/report.md](references/report.md)。
