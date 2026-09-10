---
name: replenishment-msku-download
description: 按已解析的马帮 Amazon FBA 店铺 ID 下载该店铺 MSKU 数据 Excel。用户要求获取某个单店或欧洲子站点的 MSKU 数据、店铺 MSKU 表、补货用 MSKU 数据时使用；如果用户只给店铺名，先使用 replenishment-store-resolve 解析 store_name、store_id 和 id_type。
type: amazon_replenish
commands:
  - lxeskill replenish msku download
---

# 下载并核验 MSKU 源表

## 执行与错误

- 通过 `exec` 调用本 Skill 声明的 CLI；不手工拼 API、不猜 ID 或凭据、不直接执行 Python 业务模块。
- 只把最后一条 `type="result"` 当作 terminal：先看 `ok`，业务字段读 `data`，附件读 `files`；失败保留 `error.message` 和相关 `data.context`，不把业务示例当成完整 terminal。
- 命令返回运行中/session running 时等待同一会话，不重复启动下载或导出。
- 只有 `data.auth_refresh_required=true` 才按 `lxeskill auth refresh` 的恢复流程刷新一次，再重试失败步骤；为 false 或缺失时停止并保留诊断，不凭错误文本中的 401/403 或 ID 猜测认证失败。
- 店铺歧义展示真实候选供选择；绑定冲突、分页异常、数据服务权限错误停止。文件占用时提示关闭对应文件后重试，不删除目标。
- 源表“站点”是展示标签，欧洲各国均可能显示“欧洲站”；原样保留，不与国家代码比较，不据此拒绝或要求修改原表。下载入口的店铺 ID、单站点限制和源表店铺名称校验仍生效，失败时保留实际字段。
- 业务执行中不修改安装目录脚本、依赖或历史报表绕过错误；用户另行要求源码修复时按开发任务处理。
- 完整备货任务按 `replenishment-workflow-map` 连续推进；单步请求只执行指定步骤，缺前置数据时说明缺什么及下一步，不自行扩展为完整备货。
- 单步文件任务成功后调用 `send_files(paths=<terminal.files>)`；完整任务的中间文件保留，到最终计算完成才发送最终 terminal `files`。没有附件时不猜路径。发送成功才说已交付，发送失败只重试交付，不重跑业务。

## 使用与命令

用户需要单店、单站点 MSKU 数据时使用。缺少名称、ID 或类型时先读 `replenishment-store-resolve` 取得结果，不猜 ID。

```text
lxeskill replenish msku download --store-id "<ID>" --id-type "<fbaWarehouseIds[]|shopId>" --store-name "<规范店铺名>"
```

## 结果与下一步

- CLI 保留网页下载和 XLSX 转换，随后按 XLSX 本地 SKU 去重，批量查询官方库存 SKU 接口（每批最多 50 个），未命中项再逐个查组合明细；不请求 Listing；只有全部成功才发布源表。后续只使用 `data.xlsx_path`。
- 返回字段沿用旧名，`binding_verified_row_count` 现在表示源表本地 SKU 的商品类型已确认，并不表示实时 Listing 绑定一致。
- 记录 `original_row_count`、`binding_verified_row_count`、`binding_unverified_row_count`：原始行数＝商品类型核验通过行数＋未通过行数。全部原始行进入销量分析，核验通过不代表一定建议发货。
- 库存和组合接口均完整查询成功但都未精确命中的本地 SKU，对应 MSKU 保留在源表和销量分析中，不进入备货计算。接口失败、分页异常或无效组件必须报错，不能当作未命中。`Amazon.Found.*` 遵循同一规则，不作名称特判。
- 隐藏 `源数据核验信息` 使用版本 3，保存本轮本地 SKU 查询结果、组合组件、店铺站点和源指纹；MSKU 与本地 SKU 的绑定以原始 XLSX 为准。不能改标记、替换绑定或删除核验页；历史 Active/Listing 核验文件需重新下载并重跑销量和库存报表。
- `data.context.reason=multi_site_group` 时展示 `context.candidates` 的真实子站点，用户选择后再调用；不重试整组、不自动拆任务。
- 完整任务下载成功后继续销量与库存；单步请求交付源表即可。没有可计算记录时结束并说明原因，不生成补货建议。
- 官方数据服务依赖 `LXE_DATA_SERVER_URL`、`LXE_DATA_SERVER_API_KEY`（安装版由桌面注入，可能承载设备凭据）；不索取或展示密钥。网页仍依赖马帮登录态，官方错误不刷新 Cookie。
- 命令最长 30 分钟，官方阶段 25 分钟，进度在 stderr。同一分钟目标文件冲突时保留原文件，到下一分钟重试，不删除历史文件。
