---
name: fba-stock-sku-download
description: 根据本地 FBA 发货单 CSV 的 SKU发货量 列下载马帮库存 SKU Excel。用户要求按 SP 单号获取库存 SKU 表、库存 SKU Excel、库存数据表时使用。
type: amazon_fba
commands:
  - lxeskill fba stock-sku download
---

# FBA Stock SKU Download

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI。
- 不要自己拼接马帮 API 请求，不要手写或复用 Cookie/token。
- SKU 来源固定为本地 FBA 发货单 CSV 的 `SKU发货量` 列；不要使用 `SKU` 或 `MSKU` 列。
- `SKU发货量` 的数量不参与导出，CLI 只抽取库存 SKU。
- 本地没有发货单文件时，直接转述 CLI 失败原因，让用户先准备发货单数据。
- CLI 可能运行几十秒；命令仍在运行时不要频繁轮询或重复启动。

## Required Input

- `delivery_no`: `SP` 开头的发货单号。
- 缺少 `SP...` 时先追问，不要启动 CLI。

## Command

```text
lxeskill fba stock-sku download --delivery-no <SP单号>
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

## Result Handling

- `success=true`：告诉用户库存 SKU Excel 已下载完成，并提供 `xlsx_paths`。
- terminal `files` 非空时一次调用 `send_files(paths=<terminal.files>)`。
- `batch_count > 1`：说明 SKU 较多，文件已分批导出。
- `success=false`：只转述 `exception`。
