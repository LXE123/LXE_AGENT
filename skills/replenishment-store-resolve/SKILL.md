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

用户未指定具体店铺、提供模糊店铺名、需要网页下载 ID 或查看候选时使用（此处为马帮网页查询 ID，不是紫鸟店铺 ID）：

```text
lxeskill replenish store resolve --store-name "<店铺名>"
lxeskill replenish store resolve
```

- 省略 `--store-name` 时返回店铺数量及列表文件 `data.xlsx_path`（“店铺列表”工作表含 `店铺名称`、`ID`、`ID类型`、`父级店铺名称`）；模糊匹配失败时返回 `data.candidates` 及候选文件。
- 单独查询全部店铺时直接交付列表文件并简述数量；在完整备货或需确认候选时读取列表/候选，结合用户已给的站点或名称线索，通过 `ask_user_question` 展示真实选项（每题最多 4 项，候选较多时先按 `父级店铺名称` 分组选择，再选到单站点，同名项附带父级名称或 ID 区分）。

## 结果与下一步

- 成功匹配单店且有 `data.store_id`：保留规范 `store_name`、`store_id`、`id_type`（解析旧名称时使用 CLI 返回的规范名称，不删改国家文字猜别名），完整任务返回 `replenishment-workflow-map` 继续。
- `id_type` 仅有 `fbaWarehouseIds[]`、`shopId` 两种，不可混用；`fbaWarehouseIds[]` 也可能对应单站点，不能仅凭 `id_type` 判定为多站点整组。多站点整组由下游 `mabang-store-msku-export` 依据真实父子关系拦截。
- 网页下载及源数据核验直接使用解析出的 `store_name`、`store_id` 和 `id_type`，不要求出现在官方店铺列表中，也不将网页仓库 ID 当作官方 `sid`。
