---
name: replenishment-sales-analyze
description: 基于本地已下载的马帮 Amazon 店铺 MSKU 数据生成销量分析报告。用户要求分析某个店铺的链接销量、ASIN销量、MSKU销量趋势、补货前销量趋势报告或“xxx店铺销量分析报告”时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: replenishment
commands:
  - lxeskill replenish sales analyze
references:
  - references/report.md
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# Amazon 店铺销量分析

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 本地输入、来源或参数核验失败时说明实际错误与恢复所需输入；文件占用时提示关闭对应文件后重试。
- 完整备货由 `replenishment-workflow-map` 继续。独立单步只执行本步骤；有附件时使用 `send_files(paths=<terminal.files>)` 交付，发送失败只重试交付。

## 使用与命令

只分析本地已下载源表；单步请求缺源表时说明需下载，完整任务按流程补齐。

```text
lxeskill replenish sales analyze --store-name "<规范店铺名>"
```

模糊店铺名先读 `replenishment-store-resolve`。

## 结果与下一步

- 成功记录 `data.report_xlsx_path`、`source_xlsx_path`、`source_data_time` 及参与范围，完整任务返回 `replenishment-workflow-map` 按已确定版本继续，单步交付报告。V1依赖本报告，V2不依赖。
- 源表必须具有新版源数据核验信息。MSKU、ASIN、链接三个维度均汇总完整 XLSX 的全部记录，包括库存和组合商品接口都未命中的记录；绑定核验只限制备货计算范围。
- 隐藏源数据核验信息随报告传递，同源库存和计算依赖它。旧版无核验源表需重新下载，不能自动当成新版全量源表。
- `data_is_stale=true` 时说明源时间；用户明确选择旧数据则尊重选择。完整任务默认重新采集，不能拿旧报告替代本轮结果。
- CLI 报重复售卖项或输入冲突时保留真实错误，不自行去重、改表或补零。
- 报告结构与字段解释按需读 [references/report.md](references/report.md)。
