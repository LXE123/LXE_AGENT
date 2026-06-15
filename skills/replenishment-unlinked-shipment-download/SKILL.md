---
name: replenishment-unlinked-shipment-download
description: 按马帮 Amazon FBA 店铺名下载未关联货件原生导出文件，并基于本次下载文件生成未关联货件快照，覆盖 WMS待配货、WMS待装箱、待关联货件。用户要求测试下载未关联货件、下载未关联货件原始文件、检查备货缺失货件数据时使用。
type: amazon_replenish
---

## When to Use

- 用户要按店铺下载未关联货件原生文件。
- 用户要测试备货缺失货件数据来源。
- 用户提到 `WMS待配货`、`WMS待装箱`、`待关联货件` 三类发货单状态。
- 用户要拿到原始导出文件和可供备货计算抵扣使用的未关联货件快照。

## Hard Rules

- 只使用固定下载 CLI：`uv run --frozen python -m services.agent_cli.mabang.download_store_unlinked_shipments --store-name "<店铺名>"`
- 下载 CLI 会自动基于本次下载到的 raw 文件生成未关联货件快照。
- 不要手动拼马帮 API 请求。
- 不要手写、复用或展示 bearer/freeToken/cookie。
- 不要手动解析下载文件。
- 只以本次下载 CLI 最后一行 JSON 为准。
- 不要自动接入或修改备货计算。
- 如果店铺名不确定，先运行 `replenishment-store-resolve`，使用解析成功返回的规范 `store_name`。
- 只读取 CLI 输出的最后一行 JSON。
- 下载 CLI 失败时只转述最后一行 JSON 里的 `exception` 原文；如果是未找到店铺，可提示用户按候选店铺名重试。
- 如果最后一行 JSON 中有 `download_result`，说明 raw 文件已下载成功，但快照生成失败。

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

- 导出任务通常需要几十秒；CLI 内部会轮询马帮任务中心。
- 不要因为命令一时没有返回就重复启动。
- 如果工具返回命令仍在运行/session running，等待最终完成，或隔较长时间再查看。
- 只读取 CLI 输出的最后一行 JSON。

下载成功时：

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
  "source": "mabang_fba_unlinked_shipments",
  "snapshot": {
    "success": true,
    "store_name": "Amazon-xxx-US",
    "snapshot_time": "202606121735",
    "snapshot_xlsx_path": "artifacts/mabang_fba_unlinked_shipments_snapshots/202606121735-Amazon-xxx-US_unlinked_shipments_snapshot.xlsx",
    "raw_file_count": 1,
    "detail_count": 100,
    "msku_count": 80,
    "total_unlinked_quantity": 1200,
    "source": "mabang_fba_unlinked_shipments_snapshot"
  }
}
```

如果三个状态全部 `total = 0`，下载仍然成功，但不会生成快照：

```json
{
  "success": true,
  "store_name": "Amazon-xxx-US",
  "status_results": [],
  "snapshot": null,
  "snapshot_skipped_reason": "本次没有可生成快照的未关联货件原生文件"
}
```

失败时：

```json
{
  "success": false,
  "store_name": "Amazon-xxx-US",
  "exception": "...",
  "download_result": {
    "success": true,
    "status_results": []
  }
}
```

## Download Test Checklist

- 确认 JSON 中包含三个状态：`WMS待配货`、`WMS待装箱`、`待关联货件`。
- 对 `total > 0` 的状态，确认 `raw_file_path` 非空，并且本地文件存在。
- 对 `total = 0` 的状态，确认 `task_id`、`file_name`、`raw_file_path` 为空；这不是失败。
- 如果三个状态全部为 `total = 0`，下载流程仍算成功，不生成快照。
- 如果存在 raw 文件，确认最后一行 JSON 中 `snapshot.snapshot_xlsx_path` 非空且文件存在。

## Result Handling

- `success=true` 且 `snapshot` 非空：告诉用户未关联货件原生文件下载完成，快照也已生成。
- 回复中列出 `store_name`、`store_id`、三个状态的 `total`。
- 只列出 `total > 0` 状态的 `raw_file_path`。
- 同时列出 `snapshot.snapshot_xlsx_path`、`snapshot.msku_count`、`snapshot.total_unlinked_quantity`。
- 明确说明：本次只生成未关联货件快照，尚未自动接入备货计算。
- `success=true` 且 `snapshot=null`：告诉用户三个状态都没有可导出的未关联货件，因此没有生成快照。
- `success=false` 且有 `download_result`：说明 raw 文件已下载成功，但快照生成失败，并转述 `exception`。
- `success=false` 且没有 `download_result`：只转述 `exception`，不要猜测本地文件路径或自动切换其它下载脚本。
