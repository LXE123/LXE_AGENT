---
name: fba-stock-sku-download
description: 根据本地 FBA 发货单的 SKU发货量 列下载马帮库存 SKU Excel。用户要求按 SP 单号获取库存 SKU 表、库存 SKU Excel、库存数据表时使用。
type: amazon_fba
---

## When to Use

- 用户要获取某个 `SP...` 发货单对应的库存 SKU Excel。
- 用户说“按这个 SP 下载库存 SKU 表”“获取发货单里的库存 SKU 数据”等需求。
- 本 skill 只负责根据本地发货单里的 `SKU发货量` 列拆出库存 SKU，并下载库存 SKU Excel。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.download_stock_sku_excel`
- 不要自己拼接马帮 API 请求。
- 不要手写或复用 Cookie/token。
- SKU 来源是本地 FBA 发货单 CSV 中的 `SKU发货量` 列；不要使用 `SKU` 列或 `MSKU` 列。
- `SKU发货量` 的单项格式是 `库存SKU × 数量`，CLI 只使用库存 SKU，数量不参与导出。
- 本 CLI 只查找本地发货单文件；本地没有发货单时，直接转述 CLI 失败原因，让用户先准备发货单数据。
- CLI 可能运行几十秒；如果命令仍在运行，不要频繁轮询，也不要重复启动。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Required Input

- 必须有 `SP...` 发货单号。
- 如果用户没有提供 `SP...`，先追问，不要启动 CLI。

## How to Execute

固定执行：

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_stock_sku_excel --delivery-no <SP单号>
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "delivery_no": "SP260508022",
  "delivery_csv_path": "artifacts/mabang_fba_delivery/SP260508022_370502.csv",
  "sku_count": 120,
  "source_column": "SKU发货量",
  "batch_count": 1,
  "xlsx_paths": [
    "artifacts/mabang_stock_sku/SP260508022_batch001.xlsx"
  ],
  "source": "mabang_stock_sku_download"
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

- `success=true`：告诉用户库存 SKU Excel 已下载完成，并提供 `xlsx_paths`。
- 如果 `batch_count > 1`，告诉用户因为 SKU 数较多，文件已分批导出。
- `success=false`：只转述 `exception`。
