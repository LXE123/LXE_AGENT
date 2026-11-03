---
name: mabang-store-unlinked-shipments-export
description: 按 Amazon 店铺下载 WMS待配货、WMS待装箱、待关联货件的马帮原生文件，并生成备货扣减快照。用于店铺未关联货件查询、下载及完整备货的数据采集；指定 SP 单号下载单张发货单时使用 mabang-delivery-export。
type: replenishment
commands:
  - lxeskill mabang store unlinked-shipments export
references:
  - references/results.md
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 下载 Amazon 未关联货件并生成扣减快照

## 执行与错误

- 执行本 Skill 声明的 CLI；参数以 `lxeskill list`、`lxeskill describe <命令路径>` 为准。
- 等待原会话完成，读取最后一条 `type="result"`：先看 `ok`，业务结果读 `data`，附件读 `files`；失败保留真实 `error.message` 和可用的 `data.context`。
- 马帮业务命令在内部按需恢复认证。命令终态失败后保留实际诊断，不额外刷新或重试业务；需要再次尝试时先由用户决定。
- 完整备货由 `replenishment-workflow-map` 继续。单步文件任务成功后使用 `send_files(paths=<terminal.files>)` 交付；发送失败只重试交付。

## 范围与命令

这里的“未关联货件”包含 **WMS待配货、WMS待装箱、待关联货件** 三个状态（页面上“待关联货件”为 0 不代表另外两个状态为空）。模糊店铺名先读 `replenishment-store-resolve`。

```text
lxeskill mabang store unlinked-shipments export --store-name "<规范店铺名>"
```

一次调用包含三个状态的分页计数、有数据状态的批量导出、任务轮询、原生文件（CSV）下载和 XLSX 扣减快照生成，无需逐张 SP 下载或自行转换。

## 结果判断与下一步

成功需同时满足 `ok=true`、三个状态结果完整、`data.snapshot` 存在且有 `snapshot_xlsx_path` 和布尔值 `confirmed_empty`：

| 字段 | 含义 |
|---|---|
| `data.status_results[].total` | CLI 分页统计的该状态发货单张数 |
| `data.snapshot.total_unlinked_quantity` | 快照汇总的商品总件数，用于备货扣减 |
| `data.snapshot.msku_count` / `detail_count` | 快照涉及的 MSKU 数 / 商品明细行数（非发货单张数） |

- `confirmed_empty=false`：存在未关联发货单并已生成快照（允许部分状态为 0）。
- `confirmed_empty=true`：三个状态均成功查询且单据张数全为 0，已生成有效的零货件快照；正常进入备货计算按 0 扣减，不重复下载。
- 单步查询成功后交付 `terminal.files`，回复店铺名、三个状态的发货单张数、快照 MSKU 数和商品总件数，并说明该快照为备货扣减输入。完整备货保留 `data.snapshot.snapshot_xlsx_path` 返回 `replenishment-workflow-map` 继续。
- `data.download_result` 存在而 `ok=false` 表示原生文件已下载但快照生成失败，不可当作可用快照，也不把内层路径冒充 `files`。任一状态查询缺失或快照不可用时停止正式备货计算，不按 0 扣减或回退旧快照。返回结构示例见 [返回参考](references/results.md)。
