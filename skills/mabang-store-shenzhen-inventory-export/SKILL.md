---
name: mabang-store-shenzhen-inventory-export
description: 基于本地已下载的马帮 Amazon 店铺 MSKU 数据查询并生成真实库存（深圳仓库）报告。用户要求查看某个店铺 MSKU、本地SKU、组合SKU 或备货分析所需的真实库存（深圳仓库）数量时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
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
- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 马帮业务命令在内部按需恢复认证。命令终态失败后保留实际诊断，不额外刷新或重试业务；需要再次尝试时先由用户决定。
- 完整备货由 `replenishment-workflow-map` 继续。单步文件任务成功后使用 `send_files(paths=<terminal.files>)` 交付；发送失败只重试交付。

## 使用与命令

基于本地 MSKU 源表查询深圳库存；完整任务由 `replenishment-workflow-map` 提供本轮源表并编排后续步骤。

```text
lxeskill mabang store shenzhen-inventory export --store-name "<规范店铺名>"
```

以上旧调用保留按店铺选择本地最新 MSKU 源表的行为。V2等已取得明确源表的任务，使用导出实际返回的路径：

```text
lxeskill mabang store shenzhen-inventory export --store-name "<规范店铺名>" --msku-source-xlsx-path "<MSKU导出返回的xlsx_path>"
```

显式路径只读取指定文件，缺失、损坏、文件名时间无效或店铺/来源核验失败时停止，不回退历史最新文件；该路径由 Agent 传递，不要求运营上传文件。

模糊名称先读 `replenishment-store-resolve`。最长 30 分钟，等待最终 terminal。

## 数据边界与结果

- 仅对通过绑定核验且有本地 SKU 的记录查询库存，复用源表核验页保存的本地 SKU 类型和组合组件；不查询 Listing，不重复查询商品接口，绑定以原始 XLSX 为准。
- 按本轮保存的组合明细展开并去重库存 SKU，再查询深圳仓库。组合可用套数是各子 SKU 库存除以捆绑数向下取整后的最小值；任一子 SKU 缺库存则未知，不能当作 0 或跳过该子项。
- 缺新版核验信息、快照被修改或组合明细损坏时停止并保留真实错误，不回退旧组合导出。全部未通过绑定核验时不查询仓库，仍可生成库存异常明细；本步骤只输出库存报告，是否生成建议由所选备货流程决定。
- 深圳仓库数据是马帮的“可用库存量”，不是 FBA 或 Amazon 后台库存。
- 官方数据服务凭据由桌面注入；仓库查询需要马帮登录态。官方 API 错误不触发 Cookie 刷新。
- 成功保留 `data.shenzhen_warehouse_inventory_report_xlsx_path`、`source_msku_xlsx_path`、`source_msku_data_time`，完整任务返回 `replenishment-workflow-map`，按已确定版本继续。
- 缺本地 SKU 指向“无本地SKU”；库存和组合商品接口都未命中的记录在“无库存数据”中写明 SKU 类型未核验；普通备货按原核验规则排除未通过商品。未知库存留空，不能补零，也不能把未匹配记录当普通 SKU。
- V2使用本报告“真实库存（深圳仓库）数量”生成AG，保留全部MSKU和14个公式字段；商品类型核验未通过本身不阻断V2，普通备货仍按原核验规则排除未通过商品。报告包含普通与组合商品的真实0、有限负数；“无本地SKU”“无库存数据”为未知。文件级来源异常仍须失败停止；版本计算及未知库存交付按 `replenishment-workflow-map` 继续。
- 保留隐藏源数据核验信息；不能仅凭文件日期判断与销量报告同源。字段与数量定义按需读 [references/report.md](references/report.md)。
