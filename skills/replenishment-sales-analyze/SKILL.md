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
- 本地输入、来源或核验失败时说明实际错误与恢复所需输入；文件占用时提示关闭对应文件后重试。
- 本步骤用于独立生成销量分析报告（V1/V2 备货计算直接读取 MSKU 源表，不依赖本报告）。成功后调用 `send_files(paths=<terminal.files>)` 交付，发送失败只重试交付。

## 使用与命令

基于本地已下载的店铺 MSKU 源表生成销量分析报告；模糊店铺名先读 `replenishment-store-resolve`：

```text
lxeskill replenish sales analyze --store-name "<规范店铺名>"
```

本地缺少对应店铺的 MSKU 源表或旧版源表缺少核验信息时，说明需先通过 `mabang-store-msku-export` 下载新版源表。

## 结果与下一步

- 成功后交付 `files`，说明 `source_xlsx_path`、`source_data_time`、链接数（`link_count`）、ASIN 行数（`asin_count`）和 MSKU 行数（`msku_count`）。
- `data_is_stale=true` 时向用户说明源数据时间；用户明确要求最新数据时再重新下载源表。
- 重复 MSKU 逐行分析并保留，聚合表会累计各行销量；交付时转述 `data.warnings` 中的重复累计提示。其他输入错误保留真实原因。
- 报告 Sheet 结构与字段说明按需读取 [references/report.md](references/report.md)。
