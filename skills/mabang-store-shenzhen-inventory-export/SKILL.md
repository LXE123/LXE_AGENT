---
name: mabang-store-shenzhen-inventory-export
description: 基于本地已下载的马帮 Amazon 店铺 MSKU 数据查询并生成真实库存（深圳仓库）报告。用户要求查看某个店铺 MSKU、本地SKU、组合SKU 或备货分析所需的真实库存（深圳仓库）数量时使用；如果用户只给模糊店铺名，先使用 amazon-replenishment 获取规范 store_name。
type: replenishment
commands:
  - lxeskill mabang store shenzhen-inventory export
references:
  - references/report.md
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# Amazon 备货真实库存（深圳仓库）

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成（最长约 30 分钟），读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 马帮业务命令在内部按需恢复认证（仓库库存查询使用马帮登录态）。命令终态失败后保留实际诊断，不额外刷新或重试业务；需要再次尝试时先由用户决定。
- 完整备货由 `amazon-replenishment` 继续。单步任务成功后使用 `send_files(paths=<terminal.files>)` 交付；发送失败只重试交付。

## 使用与命令

基于本地 MSKU 源表查询马帮深圳仓库的“可用库存量”（非 FBA 或 Amazon 后台库存）。模糊店铺名先读 `amazon-replenishment` 解析店铺。

完整备货任务或已取得明确源表路径时，显式传入源表路径（缺失、损坏或店铺/核验不匹配时直接报错停止，不回退其他文件）：

```text
lxeskill mabang store shenzhen-inventory export --store-name "<规范店铺名>" --msku-source-xlsx-path "<MSKU导出返回的xlsx_path>"
```

独立单步查询且未指定源表文件时，可省略 `--msku-source-xlsx-path`，由 CLI 选择该店铺本地最新 MSKU 源表：

```text
lxeskill mabang store shenzhen-inventory export --store-name "<规范店铺名>"
```

## 数据边界与结果

- 复用源表 `源数据核验信息` 中保存的本地 SKU 类型和组合组件，仅对通过绑定核验且有本地 SKU 的记录展开库存 SKU 并查询深圳仓库。组合可用套数为各子 SKU 库存除以捆绑数向下取整后的最小值；任一子 SKU 缺库存则组合库存未知（留空，不补 0）。
- 源表缺少新版核验信息或核验数据损坏时停止并报告实际错误。源表全部记录均未通过绑定核验时不请求仓库接口，仍生成包含 `无本地SKU`、`无库存数据` 的库存报告。
- 缺少本地 SKU 的记录归入 `无本地SKU`；未通过商品类型核验或未查到深圳仓库库存的记录归入 `无库存数据`（库存列留空，不补 0）。已查到的普通与组合商品保留真实 `0` 和有限负数。
- 成功后保留 `data.shenzhen_warehouse_inventory_report_xlsx_path`、`source_msku_xlsx_path`、`source_msku_data_time`。单步请求直接交付文件；完整备货返回 `amazon-replenishment` 继续。
- 报告写入隐藏的 `源数据核验信息` 供下游同源校验，不能仅凭文件日期判断与 MSKU 源表同源。详细 Sheet 结构与统计字段见 [references/report.md](references/report.md)。
