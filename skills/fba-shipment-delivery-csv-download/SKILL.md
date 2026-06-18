---
name: fba-shipment-delivery-csv-download
description: 下载马帮 FBA 发货单 SKU 数据 CSV。用户要求获取、导出、下载 FBA 发货单、发货单 SKU 数据、发货单表格、SP 发货单 CSV 时使用；不要用于 WMS 装箱数据或托运单 Excel。
type: amazon_fba
---

# FBA Delivery CSV Download

## Hard Rules

- 只使用固定 CLI。
- 不要直接拼马帮 API 请求，不要手写、复用或展示 bearer/freeToken。
- 当前 v1 交付马帮导出的 CSV，不要转换成 xlsx。
- CLI 可能运行几十秒；命令仍在运行时不要频繁轮询或重复启动。
- CLI 失败时只转述最后一行 JSON 的 `exception` 原文。

## Required Input

- `delivery_no`: `SP` 开头的发货单号。
- 缺少明确 `SP...` 发货单号时先追问，不要启动 CLI。

## Command

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_fba_delivery_csv --delivery-no <delivery_no>
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户 FBA 发货单 CSV 已下载完成，并提供 `csv_path`。
- 用户要求发送文件时，调用 `send_file` 发送 `csv_path`；该路径应位于 `artifacts/mabang_fba_delivery/`。
- `success=false`：只转述 `exception`。
