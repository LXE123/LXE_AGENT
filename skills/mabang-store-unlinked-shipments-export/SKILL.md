---
name: mabang-store-unlinked-shipments-export
description: 按 Amazon 店铺下载 WMS待配货、WMS待装箱、待关联货件的马帮原生文件，并生成备货扣减快照。用于店铺未关联货件查询、下载及完整备货的数据采集；指定 SP 单号下载单张发货单时使用 mabang-delivery-export。
type: replenishment
commands:
  - lxeskill mabang store unlinked-shipments export
references:
  - references/results.md
---

# 下载 Amazon 未关联货件并生成扣减快照

## 范围与输入

这里的“未关联货件”包含 **WMS待配货、WMS待装箱、待关联货件** 三个状态。页面上“待关联货件”为 0，不代表另外两个状态也为空；各状态可以有不同数量。

- 输入为规范店铺名；已有明确名称时直接使用，模糊名称读取 `replenishment-store-resolve`，有歧义时展示真实候选供选择。
- 单步查询或下载只完成本步骤。完整备货任务按 `replenishment-workflow-map` 继续，不在生成快照后提前结束。
- 用户仅询问流程或已有结果时直接解释，不因此启动新下载。

## 执行

通过 `exec` 调用：

```text
lxeskill mabang store unlinked-shipments export --store-name "<规范店铺名>"
```

一次调用已包含三个状态的分页计数、有数据状态的批量导出、任务轮询、原生文件下载和 XLSX 快照生成。原生文件可能是 CSV，保留其格式；无需自行转换、逐张 SP 下载或另算商品明细。不要手工拼 API、猜 ID/凭据或直接执行 Python 业务模块。

命令仍在运行时等待同一执行会话，不因日志暂时没有进展而重复启动。只把最后一条 `type="result"` 当作终态；进度日志不是最终结果。先看 `ok`，业务结果读 `data`，交付路径读 `files`。

## 结果判断

成功需同时满足 `ok=true`、三个状态结果完整、`data.snapshot` 存在且有 `snapshot_xlsx_path` 和布尔值 `confirmed_empty`。缺项、`snapshot=null` 或 `ok=false` 都不能当作可用快照。

| 字段 | 含义 |
|---|---|
| `data.status_results[].total` | CLI 分页统计的该状态发货单张数，不依赖马帮响应提供同名字段 |
| `data.snapshot.total_unlinked_quantity` | 快照汇总的商品件数，用于后续备货扣减 |
| `data.snapshot.msku_count` / `detail_count` | MSKU 数量 / 商品明细行数，不是发货单张数 |

- `confirmed_empty=false`：本轮存在发货单且已生成快照；允许某个状态为 0。使用 CLI 的件数汇总，不拿单据张数或列表中的部分商品明细代替。
- `confirmed_empty=true`：三个状态均查询成功且单据张数全为 0，已生成有效的零货件快照。正常进入计算扣减 0，不重复下载。不能仅凭商品件数为 0 自行推断此标记。
- 返回字段互相矛盾时保留原结果并停止正式计算，不自行修正或补齐。

## 交付与后续

- 单步任务成功后，用终态 `files` 一次调用 `send_files(paths=<terminal.files>)`。发送成功才说已交付；发送失败仅重试交付，不重新导出。没有路径时不猜文件位置。
- 完整备货任务保留本轮快照，按流程进入计算 Skill，显式传入 `--unlinked-shipments-snapshot`；与本轮源表同店、同日，以 CLI 核验为准。中间文件保留，最终发送计算结果的 `files`。
- 回复店铺、三个状态的发货单张数、快照中的 MSKU 数和商品件数。说明这是备货扣减输入，不能宣称已完成备货建议，也不手工再扣一次。

## 失败与恢复

- 说明日志或终态能确认的失败阶段，保留 `error.message` 和可用的 `data.context`。没有证据时不归因于马帮故障、认证过期或零货件，也不把“稍后重试”当作已确认的解决办法。
- `data.download_result` 存在表示原生下载已完成、快照阶段失败；它不是成功快照，也不代表查询全失败。没有该字段时，不推断所有状态均未查询或没有任何文件落盘。
- 失败、状态缺失或快照不可用时，停止正式备货建议；保留已成功产物，不按零计算、不回退旧快照、不修改历史文件日期或核验信息。
- 本命令内部已处理一次认证刷新重试。终态失败后不凭错误文本或单独的 `recovery.command` 再刷新；仅当 `data.auth_refresh_required=true` 且本轮尚未执行认证恢复时，按 `lxeskill auth refresh` 流程恢复一次并重试。标记为 false 或缺失时保留诊断，不叠加认证重试。
- 文件占用时提示关闭占用文件后再试，不删除目标。业务执行中不改脚本、依赖或报表绕过错误；源码修复作为另行授权的开发任务处理。

需要核对混合状态、全零、快照失败的返回形状或快照内部结构时，读取 [返回参考](references/results.md)。
