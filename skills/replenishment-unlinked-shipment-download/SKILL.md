---
name: replenishment-unlinked-shipment-download
description: 按马帮 Amazon FBA 店铺名下载未关联货件原生导出文件，并基于本次下载文件生成未关联货件快照，覆盖 WMS待配货、WMS待装箱、待关联货件。用户要求测试下载未关联货件、下载未关联货件原始文件、检查备货缺失货件数据时使用。
type: amazon_replenish
commands:
  - lxeskill replenish shipments unlinked-download
references:
  - references/results.md
---

# 下载未关联货件并保存快照

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

查询马帮 `WMS待配货`、`WMS待装箱`、`待关联货件` 三个状态，下载本轮原生文件并生成扣减快照。

```text
lxeskill replenish shipments unlinked-download --store-name "<规范店铺名>"
```

模糊名称先读 `replenishment-store-resolve`，不猜店铺 ID。导出需要轮询，等待原会话，不重复启动。

## 三种结果

- `terminal.ok=true` 且 `data.snapshot.confirmed_empty=false`：快照已生成，计算时使用本次 `snapshot.snapshot_xlsx_path` 扣减；简述未关联总数量。
- `terminal.ok=true` 且 `data.snapshot.confirmed_empty=true`：三个状态均查询成功且记录数全为零。已保存确认零货件快照，正常进入计算扣减 0；不要再次下载，也不能说“未取得快照”。
- `terminal.ok=false`、缺状态、缺快照或快照生成失败：完整任务停止正式建议，不按零货件计算、不改用旧快照；保留实际错误。有 `data.download_result` 表示原生下载已完成但快照阶段失败，不等于查询全失败。

## 后续与交付

- 完整任务记录本轮快照路径，切换计算 Skill，显式传入 `--unlinked-shipments-snapshot`；先确认与本轮源表同店、同日，不改日期绕过。
- 单步任务发送 terminal files；说明已生成可用于扣减的快照，不宣称已经完成备货计算。
- 汇总、明细两个业务 Sheet 保留，确认零货件时只有表头，不伪造商品行。隐藏核验信息记录查询店铺、时间、三个状态及版本，不删除。
- 旧版返回 `snapshot=null` 不能当作已确认零货件，不反复下载；保留结果并说明当前版本未提供可用快照。
- 返回示例与核验字段按需读 [references/results.md](references/results.md)。
