---
name: fba-shipment-delivery-csv-download
description: 下载马帮 FBA 发货单 SKU 数据 CSV。用户要求获取、导出、下载 FBA 发货单、发货单 SKU 数据、发货单表格、SP 发货单 CSV 时使用。
type: amazon_fba
---

## When to Use

- 用户要获取马帮 FBA 发货单 SKU 数据。
- 用户要导出或下载 FBA 发货单表格。
- 用户提供 `SP...` 发货单号，并要求返回发货单 CSV。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.download_fba_delivery_csv`
- 不要直接拼马帮 API 请求。
- 不要手写、复用或展示 bearer/freeToken。
- 不要把 CSV 转换成 xlsx；当前 v1 交付马帮导出的 CSV。
- 本 skill 只下载 FBA 发货单 SKU CSV；WMS 装箱/托运单 Excel 不属于本流程。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Required Input

- 必须有一个 `delivery_no`。
- 单号必须是 `SP` 开头的发货单号。
- 如果用户没有提供 `SP...` 单号，先追问，不要启动 CLI。

## How to Execute

固定执行：

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_fba_delivery_csv --delivery-no <delivery_no>
```

- 发货单导出通常需要几十秒；CLI 内部已经会轮询马帮导出任务直到完成。
- 如果工具返回命令仍在运行/session running，AI 不要频繁轮询该 session，也不要硬等刷日志；等待最终完成通知，或隔较长时间再查一次。
- 如果命令一时没有返回，等待当前命令完成；下载入口保持固定 CLI。

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "delivery_no": "SP260508022",
  "delivery_id": 147674,
  "task_id": 370502,
  "file_hash": "...",
  "file_name": "...csv",
  "csv_path": "artifacts/mabang_fba_delivery/SP260508022_370502.csv",
  "source": "mabang_fba_delivery"
}
```

失败时：

```json
{
  "success": false,
  "delivery_no": "SP260508022",
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户 FBA 发货单 CSV 已下载完成，并提供 `csv_path`。
- 如果用户要求“发给我”或“发送文件”，使用 CLI 返回的 `csv_path` 发送文件；该路径位于 `artifacts/mabang_fba_delivery/`。
- `success=false`：只转述 `exception`。
