---
name: fba-shipment-wms-box-download
description: 下载马帮 WMS 托运单装箱数据 Excel。用户明确要求装箱数据、托运单 Excel、WMS 下载、原始装箱数据、不要拆分装箱数据，或为 Amazon FBA 创建货件准备装箱 Excel 时使用；不要用于 FBA 发货单、发货单 SKU 数据、发货单表格下载。
type: amazon_fba
commands:
  - lxeskill fba shipment wms-box-download
---

# WMS Box Download

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只执行固定 CLI；不要调用 Python 内部函数。
- 只在用户明确提到 WMS、装箱数据、托运单 Excel 或创建货件前置装箱文件时使用。
- 下载前必须明确 `split-mode`：`auto` 或 `original`。用户没说明就先追问。
- 不要猜测本地路径；以 CLI 返回的 `excel_path` 和 `split_excel_paths` 为准。
- CLI 失败时只转述 `exception` 原文。

## Required Input

- `ship_no` 或 `consignment_no`，必须是 `SP` 开头。
- `split-mode`：
  - `auto`: 用户说“自动拆分”“按系统默认”“超过 5 箱拆分”。
  - `original`: 用户说“使用原始装箱数据”“原始文件”“不要拆分”“不拆”。

## Command

```text
lxeskill fba shipment wms-box-download --ship-no <ship_no> --split-mode auto
```

```text
lxeskill fba shipment wms-box-download --ship-no <ship_no> --split-mode original
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

## Result Handling

| Result | Meaning | 后续创建货件 `consignment_no` |
|---|---|---|
| `split_mode=original` | 按用户要求保留原始装箱数据；即使超过 5 箱也不拆分 | 原始 `ship_no` |
| `split_mode=auto` 且 `split_required=true` | 超过 5 箱，已按每 5 箱生成拆分文件 | 拆分文件名对应编号，如 `SP2000202021-1` |
| `split_mode=auto` 且 `split_required=false` | 未超过拆分阈值 | 原始 `ship_no` |

- `success=true`：告诉用户托运单 Excel 已准备好，并保留 `excel_path`。
- 如有 `split_excel_paths`，列出这些拆分文件供后续创建货件使用。
- 如有 `split_skipped_reason`，简要转述。
- `success=false`：只转述 `exception` 原文。
- 用户继续创建 Amazon FBA 货件时，切到 `fba-shipment-create`。
