---
name: fba-export-tax-delivery-summary
description: 统计 FBA 发货单出口退税 SKU 汇总。用户要求按 SP 发货单统计出口退税产品、汇总 SKU 发货量、生成退税产品 xlsx 时使用。
type: amazon_fba
commands:
  - lxeskill fba export-tax delivery-summary
---

# Export Tax Delivery Summary

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI。
- 不要自己解析 CSV，不要自己生成 xlsx。
- 退税产品表必须来自当前对话附件；只使用附件下载结果中的真实绝对路径。禁止猜测路径、扫描系统目录或使用安装目录内的业务文件。
- 缺少退税产品表附件时停止执行并向用户索取文件，不要调用 CLI。
- 不可出口退税 SKU 的产品名由 CLI 自动通过马帮库存 SKU 导出补全。
- 不要手写或复用 bearer/freeToken/Cookie。

## Required Input

- `delivery_no`: `SP` 开头的发货单号。
- `products_path`: 用户上传的出口退税产品表 `.xlsx` 的真实绝对路径。
- 缺少 `SP...` 时先追问，不要启动 CLI。

## Command

```text
lxeskill fba export-tax delivery-summary --delivery-no <delivery_no> --products-path <uploaded_products_xlsx_path>
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

## Result Handling

- `success=true`：告诉用户出口退税 SKU 汇总 xlsx 已生成，并提供 `xlsx_path`。
- terminal `files` 非空时逐个调用 `send_file`；库存 SKU 中间文件不主动发送。
- 说明结果包含 `可出口退税` 和 `不可出口退税` 两个 sheet。
- 可简要转述 `matched_sku_count`、`unmatched_sku_count`、`stock_name_missing_count`。
- `success=false`：只转述 `exception`。
