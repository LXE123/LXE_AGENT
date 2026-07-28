---
name: fba-shipment-delivery-csv-download
description: 下载马帮 FBA 发货单 SKU 数据 CSV。用户要求获取、导出、下载 FBA 发货单、发货单 SKU 数据、发货单表格、SP 发货单 CSV 时使用；不要用于 WMS 装箱数据或托运单 Excel。
type: amazon_fba
commands:
  - lxeskill fba shipment delivery-csv-download
---

# FBA Delivery CSV Download

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI。
- 不要直接拼马帮 API 请求，不要手写、复用或展示 bearer/freeToken。
- 当前 v1 交付马帮导出的 CSV，不要转换成 xlsx。
- CLI 可能运行几十秒；命令仍在运行时不要频繁轮询或重复启动。
- CLI 失败时只转述 terminal 的 `error.message`；需要定位阶段时可读取 `data.context`。

## Required Input

- `delivery_no`: `SP` 开头的发货单号。
- 缺少明确 `SP...` 发货单号时先追问，不要启动 CLI。

## Command

```text
lxeskill fba shipment delivery-csv-download --delivery-no <delivery_no>
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

## Result Handling

- `success=true`：告诉用户 FBA 发货单 CSV 已下载完成，并提供 `csv_path`。
- terminal `files` 非空时一次调用 `send_files(paths=<terminal.files>)`；不要直接发送未经校验的 `data.csv_path`。
- `success=false`：只转述 `exception`。
