---
name: replenishment-real-inventory-report
description: 基于本地已下载的马帮 Amazon 店铺 MSKU 数据查询并生成真实库存（深圳仓库）报告。用户要求查看某个店铺 MSKU、本地SKU、组合SKU 或备货分析所需的真实库存（深圳仓库）数量时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
commands:
  - lxeskill replenish inventory actual-export
references:
  - references/report.md
---

# 真实库存（深圳仓库）

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

基于本地 MSKU 源表查询深圳库存；单步请求不自行扩展成全流程，完整任务自动补齐前置数据。

```text
lxeskill replenish inventory actual-export --store-name "<规范店铺名>"
```

模糊名称先读 `replenishment-store-resolve`。最长 30 分钟，等待最终 terminal。

## 数据边界与结果

- 仅对通过绑定核验且有本地 SKU 的记录查询库存，复用源表核验页保存的 Listing 绑定和类型；不重复拉 Listing，不用实时数据悄悄替换源表本地 SKU。
- 仅查询去重组合 SKU 的官方明细，再查询深圳仓库。组合可用套数是各子 SKU 库存除以捆绑数向下取整后的最小值；任一子 SKU 缺库存则未知，不能当作 0 或跳过该子项。
- 缺新版核验信息、绑定冲突、组合明细缺失时停止并保留真实错误，不回退旧组合导出。全部未通过绑定核验时不查询仓库，仍可生成库存异常明细，不生成备货建议。
- 深圳仓库数据是马帮的“可用库存量”，不是 FBA 或 Amazon 后台库存。
- 官方数据服务凭据由桌面注入；仓库查询需要马帮登录态。官方 API 错误不触发 Cookie 刷新。
- 成功保留 `data.shenzhen_warehouse_inventory_report_xlsx_path`、`source_msku_xlsx_path`、`source_msku_data_time`，完整任务继续本轮货件查询。
- 缺本地 SKU 指向“无本地SKU”；未匹配 Listing 的记录在“无库存数据”中写明 SKU 类型未核验并排除备货。未知库存留空，不能补零，也不能把未匹配记录当普通 SKU。
- 保留隐藏源数据核验信息；不能仅凭文件日期判断与销量报告同源。字段与数量定义按需读 [references/report.md](references/report.md)。
