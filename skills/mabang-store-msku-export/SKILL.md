---
name: mabang-store-msku-export
description: 按已解析的马帮 Amazon FBA 店铺 ID 下载该店铺 MSKU 数据 Excel。用户要求获取某个单店、单站点的 MSKU 数据、店铺 MSKU 表、补货用 MSKU 数据时使用；如果用户只给店铺名，先使用 replenishment-store-resolve 解析 store_name、store_id 和 id_type。
type: replenishment
commands:
  - lxeskill mabang store msku export
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 下载并核验 Amazon 店铺 MSKU 源表

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成（最长约 30 分钟），读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 马帮业务命令在内部按需恢复认证（网页下载依赖马帮登录态，官方商品核验使用桌面注入的数据服务凭据）。命令终态失败后保留实际诊断，不额外刷新或重试业务；需要再次尝试时先由用户决定。
- 完整备货由 `replenishment-workflow-map` 继续。单步导出任务成功后使用 `send_files(paths=<terminal.files>)` 交付；发送失败只重试交付。

## 使用与命令

用户需要单店、单站点 MSKU 源表时使用。缺少规范店铺名、ID 或类型时先调用 `replenishment-store-resolve` 获取，不猜测 ID：

```text
lxeskill mabang store msku export --store-id "<ID>" --id-type "<fbaWarehouseIds[]|shopId>" --store-name "<规范店铺名>"
```

数据归属以下载入口选定的店铺为准；源表内的“店铺名称”和“站点”列仅作展示（可能为多店拼接或“欧洲站”），缺列、空值或文字不一致均不阻断，也不修改源表。

## 结果与下一步

- CLI 完成网页导出、XLSX 转换及官方库存/组合商品类型核验，写入并校验隐藏的 `源数据核验信息` Sheet 后发布文件。下游统一使用返回的 `data.xlsx_path`。
- 记录 `original_row_count`、`binding_verified_row_count`、`binding_unverified_row_count`（`原始行数 = 商品类型核验通过行数 + 未通过行数`）。
- 库存和组合商品接口均完整查询成功但未精确命中的本地 SKU（含 `Amazon.Found.*`），保留在源表中并标记为未通过核验；接口请求失败、分页异常或无效组合组件会直接报错停止，不当作未命中。
- `data.context.reason=multi_site_group` 时，展示 `context.candidates` 中的真实子站点供用户选择，选定后再重新调用，不拆单或重试整组。
- 单步请求交付源表即可。完整备货保留 `data.xlsx_path` 返回 `replenishment-workflow-map` 继续后续步骤；`binding_verified_row_count=0` 时仅影响 V1 计算，不阻断深圳库存异常报告生成或已授权的 V2 流程。
