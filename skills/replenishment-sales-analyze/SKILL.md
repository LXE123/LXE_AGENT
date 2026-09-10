---
name: replenishment-sales-analyze
description: 基于本地已下载的马帮 Amazon 店铺 MSKU 数据生成销量分析报告。用户要求分析某个店铺的链接销量、ASIN销量、MSKU销量趋势、补货前销量趋势报告或“xxx店铺销量分析报告”时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
commands:
  - lxeskill replenish sales analyze
references:
  - references/report.md
---

# 销量分析

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

只分析本地已下载源表；单步请求缺源表时说明需下载，完整任务按流程补齐。

```text
lxeskill replenish sales analyze --store-name "<规范店铺名>"
```

模糊店铺名先读 `replenishment-store-resolve`。

## 结果与下一步

- 成功记录 `data.report_xlsx_path`、`source_xlsx_path`、`source_data_time` 及参与范围，完整任务继续深圳库存，单步交付报告。
- 源表必须具有新版源数据核验信息。MSKU、ASIN、链接三个维度均汇总完整 XLSX 的全部记录，包括库存和组合商品接口都未命中的记录；绑定核验只限制备货计算范围。
- 隐藏源数据核验信息随报告传递，同源库存和计算依赖它。旧版无核验源表需重新下载，不能自动当成新版全量源表。
- `data_is_stale=true` 时说明源时间；用户明确选择旧数据则尊重选择。完整任务默认重新采集，不能拿旧报告替代本轮结果。
- CLI 报重复售卖项或输入冲突时保留真实错误，不自行去重、改表或补零。
- 报告结构与字段解释按需读 [references/report.md](references/report.md)。
