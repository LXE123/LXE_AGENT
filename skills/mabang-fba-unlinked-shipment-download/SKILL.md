---
name: mabang-fba-unlinked-shipment-download
description: 按马帮 Amazon FBA 店铺名下载未关联货件原生导出文件，覆盖 WMS待配货、WMS待装箱、待关联货件。用户要求测试下载未关联货件、下载未关联货件原始文件、检查备货缺失货件数据时使用。
type: amazon_replenish
---

## When to Use

- 用户要按店铺下载未关联货件原生文件。
- 用户要测试备货缺失货件数据来源。
- 用户提到 `WMS待配货`、`WMS待装箱`、`待关联货件` 三类发货单状态。
- 用户只想拿到原始导出文件，后续再人工确认文件格式。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.download_store_unlinked_shipments --store-name "<店铺名>"`
- 不要手动拼马帮 API 请求。
- 不要手写、复用或展示 bearer/freeToken/cookie。
- 不要解析下载文件，不要生成规范化快照，不要接入或修改备货计算。
- 如果店铺名不确定，先运行 `mabang-fba-store-resolve`，使用解析成功返回的规范 `store_name`。
- 只读取 CLI 输出的最后一行 JSON。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文；如果是未找到店铺，可提示用户按候选店铺名重试。

## Required Input

- 必须有一个马帮 Amazon FBA 店铺名。
- 店铺名必须能被 CLI 严格匹配到马帮店铺；不要猜店铺 ID。

## How to Execute

如果店铺名不确定，先解析店铺：

```powershell
uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store --store-name "<店铺名>"
```

解析成功后，使用规范 `store_name` 下载未关联货件原生文件：

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_store_unlinked_shipments --store-name "<店铺名>"
```

如需显式测试轮询参数：

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_store_unlinked_shipments --store-name "<店铺名>" --timeout-sec 180 --poll-interval-sec 10
```

- 导出任务通常需要几十秒；CLI 内部会轮询马帮任务中心。
- 不要因为命令一时没有返回就重复启动。
- 如果工具返回命令仍在运行/session running，等待最终完成，或隔较长时间再查看。
- 只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-xxx-US",
  "store_id": 697476809,
  "download_time": "202606121730",
  "status_results": [
    {
      "status_name": "WMS待配货",
      "total": 0,
      "task_id": null,
      "file_hash": "",
      "file_name": "",
      "raw_file_path": ""
    },
    {
      "status_name": "WMS待装箱",
      "total": 3,
      "task_id": 370502,
      "file_hash": "...",
      "file_name": "fba报表-发货单_...",
      "raw_file_path": "artifacts/mabang_fba_unlinked_shipments/..."
    }
  ],
  "source": "mabang_fba_unlinked_shipments"
}
```

失败时：

```json
{
  "success": false,
  "store_name": "Amazon-xxx-US",
  "exception": "..."
}
```

## Download Test Checklist

- 确认 JSON 中包含三个状态：`WMS待配货`、`WMS待装箱`、`待关联货件`。
- 对 `total > 0` 的状态，确认 `raw_file_path` 非空，并且本地文件存在。
- 对 `total = 0` 的状态，确认 `task_id`、`file_name`、`raw_file_path` 为空；这不是失败。
- 如果三个状态全部为 `total = 0`，下载流程仍算成功，但需要换一个有数据的店铺才能验证原生文件格式。

## Result Handling

- `success=true`：告诉用户未关联货件原生文件下载完成。
- 回复中列出 `store_name`、`store_id`、三个状态的 `total`。
- 只列出 `total > 0` 状态的 `raw_file_path`。
- 明确说明：本次只下载原生文件，尚未解析、未生成规范化快照、未接入备货计算。
- `success=false`：只转述 `exception`，不要猜测本地文件路径或自动切换其它下载脚本。
