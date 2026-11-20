# 解析马帮 Amazon 店铺

用户未指定具体店铺、提供模糊店铺名、需要网页下载 ID 或查看候选时使用（此处为马帮网页查询 ID，不是紫鸟店铺 ID）：

```text
lxeskill replenish store resolve --store-name "<店铺名>"
lxeskill replenish store resolve
```

- 马帮业务命令在内部按需恢复认证；终态失败后保留实际诊断，不额外刷新或重试业务。
- 省略 `--store-name` 时返回店铺数量及列表文件 `data.xlsx_path`（“店铺列表”工作表含 `店铺名称`、`ID`、`ID类型`、`父级店铺名称`）；模糊匹配失败时返回 `data.candidates` 及候选文件。
- 单独查询全部店铺时直接通过 `send_files(paths=<terminal.files>)` 交付列表文件并简述数量；在备货任务或需确认候选时读取列表/候选，结合用户已给的站点或名称线索，通过 `ask_user_question` 展示真实选项（每题最多 4 项，候选较多时先按 `父级店铺名称` 分组选择，再选到单站点，同名项附带父级名称或 ID 区分）。
- 成功匹配单店且有 `data.store_id`：保留规范 `store_name`、`store_id`、`id_type`（解析旧名称时使用 CLI 返回的规范名称，不删改国家文字猜别名）。
- `id_type` 仅有 `fbaWarehouseIds[]`、`shopId` 两种，不可混用；`fbaWarehouseIds[]` 也可能对应单站点，不能仅凭 `id_type` 判定为多站点整组。多站点整组由下游 `mabang-store-msku-export` 依据真实父子关系拦截。
- 网页下载及源数据核验直接使用解析出的 `store_name`、`store_id` 和 `id_type`，不要求出现在官方店铺列表中，也不将网页仓库 ID 当作官方 `sid`。
