---
name: mabang-store-msku-export
description: 按已解析的马帮 Amazon FBA 店铺 ID 下载该店铺 MSKU 数据 Excel。用户要求获取某个单店或欧洲子站点的 MSKU 数据、店铺 MSKU 表、补货用 MSKU 数据时使用；如果用户只给店铺名，先使用 replenishment-store-resolve 解析 store_name、store_id 和 id_type。
type: replenishment
commands:
  - lxeskill mabang store msku export
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 下载并核验 Amazon 店铺 MSKU 源表

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 马帮业务命令在内部按需恢复认证。命令终态失败后保留实际诊断，不额外刷新或重试业务；需要再次尝试时先由用户决定。
- 完整备货由 `replenishment-workflow-map` 继续。单步文件任务成功后使用 `send_files(paths=<terminal.files>)` 交付；发送失败只重试交付。
- 以下载入口选定的店铺确认数据归属。源表“店铺名称”和“站点”仅作展示，可为多店拼接或“欧洲站”；有则原样保留，缺列、空值或文字不一致均不阻断，也不要求用户改表。下载入口的名称与 ID 对应关系、单站点限制及下游同源校验仍生效。

## 使用与命令

用户需要单店、单站点 MSKU 数据时使用。缺少名称、ID 或类型时先读 `replenishment-store-resolve` 取得结果，不猜 ID。

```text
lxeskill mabang store msku export --store-id "<ID>" --id-type "<fbaWarehouseIds[]|shopId>" --store-name "<规范店铺名>"
```

V1普通备货、V2备货和单步导出均使用上述默认导出。V2的AG“本地库存”由同轮深圳库存报告提供，源表无需提供 `uq122`。

## 结果与下一步

- 商品类型核验及源表发布由 CLI 完成。成功后保留 `data.xlsx_path` 供下游使用。
- 返回字段沿用旧名，`binding_verified_row_count` 现在表示源表本地 SKU 的商品类型已确认，并不表示实时 Listing 绑定一致。
- 记录 `original_row_count`、`binding_verified_row_count`、`binding_unverified_row_count`：原始行数＝商品类型核验通过行数＋未通过行数。普通备货的销量分析保留全部原始行，核验通过不代表一定建议发货。
- 普通备货流程中，库存和组合接口均完整查询成功但都未精确命中的本地 SKU，对应 MSKU 保留在源表和销量分析中，不进入备货计算。接口失败、分页异常或无效组件在所有流程中都必须报错，不能当作未命中。`Amazon.Found.*` 遵循同一核验规则，不作名称特判。
- 已解析的网页下载 ID 可用于店铺数据获取，官方店铺列表没有该店铺不单独阻断；以本命令终态和来源核验为准。
- CLI 写入并读回隐藏的 `源数据核验信息`。旧单行格式版本 3、4 可读取；核验失败或历史 Active/Listing 源表须重新下载，再重建同轮报告。
- `data.context.reason=multi_site_group` 时展示 `context.candidates` 的真实子站点，用户选择后按选定店铺重新调用。
- 单步请求交付源表即可。完整任务保留本轮结果，返回 `replenishment-workflow-map` 按已确定的V1、V2或两种版本继续；V1没有可计算记录时仅停止V1，不阻断已授权V2。
- V2计算采用A规则保留全部MSKU和完整14个公式字段；商品类型核验未通过本身不排除行。AG使用同轮深圳真实库存，未知库存由V2计算器按临时核对规则处理，来源及其他失败条件由对应能力核验。
- 官方数据服务凭据由桌面注入，网页下载依赖马帮登录态；认证或权限错误按 CLI 终态诊断处理。
