---
name: replenishment-amazon-restock-inventory-snapshot
description: 将用户从 Seller Central 手动下载的亚马逊补充库存 CSV 解析为 Amazon V1 备货可选的对照 snapshot。用户要求使用亚马逊补充库存、解析补充库存 CSV、校验补充库存文件是否对应店铺，或询问亚马逊库存报告怎么下载/哪里下载/下载路径/截图指引时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
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

仅在用户明确要求 Amazon 侧补充库存对照或询问下载方式时使用；输入为用户从 Seller Central 手动下载的 CSV。本 Skill 不自动登录或下载 Seller Central 数据，也不替换主流程马帮库存口径。

```text
lxeskill replenish inventory restock-snapshot-build --store-name "<规范店铺名>" --csv "<CSV路径>" [--msku-xlsx "<源表路径>"]
```

未显式指定 `--msku-xlsx` 时自动匹配该店铺本地最新 MSKU 源表；模糊店铺名先读 `replenishment-store-resolve`。

## 校验与结果

- CLI 校验 CSV 必填列（`Merchant SKU`、`Total Units` 等）、与马帮 MSKU 源表的匹配率及库存分项恒等式；失败时保留实际错误，不自行转换字段。
- 成功后保留 `data.snapshot_xlsx_path` 和核验摘要。单步任务直接交付 `terminal.files`；用于 V1 备货计算时，将该路径传入 `lxeskill replenish calculate --version v1 ... --amazon-restock-inventory-snapshot "<路径>"` 进行同店与日期校验并附带核验摘要（不改变主备货建议量或工作表列结构）。
- 用户询问下载入口、截图指引或详细硬校验规则时，读取 [references/download-and-validation.md](references/download-and-validation.md) 并按指引发送已有截图资产。
