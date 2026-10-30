---
name: replenishment-amazon-restock-inventory-snapshot
description: 将用户从 Seller Central 手动下载的亚马逊补充库存 CSV 解析为 Amazon V1备货可选的对照 snapshot。用户要求使用亚马逊补充库存、解析补充库存 CSV、校验补充库存文件是否对应店铺、询问亚马逊库存报告怎么下载/哪里下载/下载路径/截图指引，或在备货建议中增加亚马逊补充库存扣减字段时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: replenishment
commands:
  - lxeskill replenish inventory restock-snapshot-build
references:
  - references/download-and-validation.md
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 亚马逊补充库存对照快照

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 本地输入、来源或参数核验失败时说明实际错误与恢复所需输入；文件占用时提示关闭对应文件后重试。
- 完整备货由 `replenishment-workflow-map` 继续。独立单步只执行本步骤；有附件时使用 `send_files(paths=<terminal.files>)` 交付，发送失败只重试交付。

## 使用与命令

只有用户明确要求 Amazon 侧库存对照时启用；输入为用户从 Seller Central 手动下载的 CSV。本 Skill 不登录或自动下载 Seller Central 数据，不替换主流程马帮库存口径。

```text
lxeskill replenish inventory restock-snapshot-build --store-name "<规范店铺名>" --csv "<CSV路径>"
```

用户明确指定马帮源表时附加 `--msku-xlsx "<源表路径>"`。名称不确定先读店铺解析 Skill；缺源表按当前完整/单步范围处理。

## 校验与结果

- CSV 必须有 Merchant SKU、Total Units。CLI 校验店铺匹配率和库存分项；失败保留实际错误，不因字段相似自行转换。
- `Amazon.Found.*` 作为真实 MSKU 参与快照校验，不按名称排除；这不改变主计算只使用通过绑定核验记录的范围。
- 成功保留 `data.snapshot_xlsx_path` 和核验摘要；用户要求用于V1计算时传 `--amazon-restock-inventory-snapshot`，增加对照字段，不重复扣减主建议。
- 单步任务交付 terminal files；完整任务保留对照快照路径到最终计算。
- 用户询问下载入口、截图或详细分项校验时读 [references/download-and-validation.md](references/download-and-validation.md)，使用已有截图资产，不猜路径。
