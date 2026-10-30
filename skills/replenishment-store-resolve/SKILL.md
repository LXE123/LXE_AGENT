---
name: replenishment-store-resolve
description: 查询马帮 Amazon 真实店铺列表、解析店铺名称和网页查询ID。用于未指定店铺时提供选择、处理模糊名称或核对ID；备货前选定单站点。
type: replenishment
commands:
  - lxeskill replenish store resolve
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 解析马帮 Amazon 店铺

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 马帮业务命令在内部按需恢复认证。命令终态失败后保留实际诊断，不额外刷新或重试业务；需要再次尝试时先由用户决定。
- 完整备货由 `replenishment-workflow-map` 继续。单步文件任务成功后使用 `send_files(paths=<terminal.files>)` 交付；发送失败只重试交付。

## 使用与命令

用户未指定具体店铺、给模糊店铺名、需要网页下载 ID 或查看候选时使用；这里不是紫鸟店铺 ID。

```text
lxeskill replenish store resolve --store-name "<店铺名>"
lxeskill replenish store resolve
```

省略店铺名时返回数量及 `data.xlsx_path`，具体候选在该文件的“店铺列表”工作表，列为“店铺名称”“ID”“ID类型”“父级店铺名称”。完整备货内读取文件，依据用户已有的站点／名称线索缩小范围，通过 `ask_user_question` 展示真实店铺选项；每题最多4项，较多时先按真实父级店铺分组选择，再选到单站点。用户选中后保留对应名称、ID与ID类型，返回主流程复用。

## 结果与下一步

- 成功且有 `data.store_id`：保留 `store_name`、`store_id`、`id_type`，完整任务返回 `replenishment-workflow-map` 按已确定版本继续。
- `id_type` 是网页请求字段，仅有 `fbaWarehouseIds[]`、`shopId` 两种。二者不能混用；`fbaWarehouseIds[]` 也可能属于单站点，不能据此认定多站点整组。
- 网页下载及本轮源数据核验使用解析出的店铺、ID 和 id_type，不要求出现在官方店铺列表中；不由模型把网页仓库 ID 转成官方 sid。
- 解析旧名称时使用 CLI 返回的规范结果，不删除名称里的国家文字来猜别名。
- 返回 `data.candidates` 或 `data.candidates_xlsx_path` 时，读取真实候选并按上述方式选择。
- 单独查询全部店铺时交付列表文件并简述数量；完整备货任务内用该文件确认店铺，选定后继续主流程。
- 多站点范围最终由 MSKU 下载入口依据真实父子关系判断；整组不能进入下载与备货。
