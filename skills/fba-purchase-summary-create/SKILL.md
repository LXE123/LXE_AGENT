---
name: fba-purchase-summary-create
description: 根据一批本地 FBA 发货单 CSV、用户提供的出口退税总表和毛利率，一次生成采购汇总表以及每个 SP 的备货单。用户要求按一批 SP 生成采购汇总、采购单、批量备货单、厂家分类采购表，或需要正飞按整批发货单统一均价时使用；不要用于 WMS 装箱数据、Amazon 创建货件、发票模板或报关资料。
type: amazon_fba
commands:
  - lxeskill fba purchase summary-create
---

# FBA Purchase Summary Create

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI。
- 不要手工解析 CSV，不要手工编辑 Excel。
- 发货单 CSV 只从本地 `artifacts/mabang_fba_delivery/<SP>_*.csv` 查找；缺少时直接转述 CLI 失败原因，不自动下载。
- 出口退税总表必须由用户提供，不使用默认路径。
- `备用厂家` 暂不参与输出。
- 日常采购/备货流程使用本批量入口；不要把一批 SP 拆开分别运行单 SP 备货单 CLI。

## Required Input

- `delivery_no`: 一个或多个 `SP` 开头的发货单号。
- `master_xlsx`: 用户提供的出口退税总表 xlsx。
- `gross_margin`: 用户指定的毛利率，必须在 `0.2` 到 `0.5` 之间。
- 出口退税总表必须包含 `SKU表` sheet；其中库存 SKU 列名可写 `库存sku` 或 `库存SKU`。
- 出口退税总表的 `供应商合同信息` sheet 用 `供货方` 匹配 `SKU表` 的 `厂家`，读取 `单位`、`合同产品名称`、`合同编号前缀` 和 `税率`；缺失或冲突时 CLI 会生成文件并在 `warnings` 中提醒。
- 缺少 `SP...`、出口退税总表路径或毛利率时先追问，不要启动 CLI。

## Command

```text
lxeskill fba purchase summary-create --delivery-no <delivery_no> --master-xlsx "<出口退税总表.xlsx>" --gross-margin <毛利率>
```

一批多个发货单号时重复传入 `--delivery-no`：

```text
lxeskill fba purchase summary-create --delivery-no <delivery_no_1> --delivery-no <delivery_no_2> --master-xlsx "<出口退税总表.xlsx>" --gross-margin <毛利率>
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

## Result Handling

- `success=true`：告诉用户采购汇总表和各 SP 备货单已生成，并提供 `purchase_summary_xlsx` 和 `restock_xlsx_paths`。
- 可简要转述 `sku_count`、`sku_source_count`、`matched_sku_count`、`unmatched_sku_count`、`restock_matched_sku_count`、`restock_unmatched_sku_count`、`manufacturer_count`、`contract_mapping_count`。
- 如果 `warnings` 非空，必须转述给用户；例如出口退税总表存在完全相同的重复库存 SKU 且已自动去重、存在 `库存sku` 为空的行且已忽略，或 `供应商合同信息` sheet 的 `供货方` 映射缺失/冲突。
- 说明第一个 sheet 是 `采购汇总`，第二个 sheet 是 `未匹配`，后续 sheet 是厂家分类。
- 说明 `采购汇总` 和厂家 sheet 已按 `型号` 合并；同型号多个库存 SKU 会在 `库存sku`、`产品名称` 单元格中按相同顺序分行显示，`来源SP单号` 按型号组去重并分行显示。
- 说明 `采购汇总` 和厂家 sheet 额外提供 `库存sku（第一行）`、`产品名称（第一行）`，用于筛选或复制代表值。
- 说明厂家名包含 `正飞` 的明细行会填写同厂家跨明细加权 `均价 = sum(原价 * 数量) / sum(数量)`，并四舍五入保留两位小数；同时填写 `总价（均价） = 均价 * 数量`；非正飞行 `均价` 和 `总价（均价）` 留空。
- 说明每个单 SP 备货单的数量只来自自己的 SP，但正飞 `均价`、`总价（均价）`、`售价(均价)` 和 `总价（售价(均价)）` 使用整批 SP 的统一均价。
- 说明每个单 SP 备货单的 `日期` 使用生成当天 `YYYY-MM-DD`，`采购订单号` 固定留空并填充颜色，方便业务人员后续补录。
- 说明批量生成的每个 `备货单` 中，`厂家` 单元格已开启自动换行，长厂家名不会横向溢出到后续字段。
- 说明批量生成的每个 `备货单` 中，`库存sku`、`产品名称`、`售价(均价)` 和 `总价（售价(均价)）` 位于最后四列，并使用灰色填充。
- 说明 `采购汇总` 和厂家 sheet 最后一行是带填充色的 `合计` 行，会汇总 `数量`、`总价` 和 `总价（均价）`。
- 说明输出表格所有列宽和行高已统一为 15。
- 说明 `采购汇总` 和厂家 sheet 字段为 `库存sku`、`产品名称`、`来源SP单号`、`库存sku（第一行）`、`产品名称（第一行）`、`型号`、`原价`、`均价`、`厂家`、`单位`、`合同产品名称`、`合同编号前缀`、`税率`、`数量`、`总价`、`总价（均价）`。
- 说明批量生成的每个 `备货单` 字段为 `日期`、`库存sku（第一行）`、`产品名称（第一行）`、`型号`、`数量`、`原价`、`厂家`、`采购订单号`、`总价（原价）`、`合同产品名称`、`均价`、`售价`、`总价（均价）`、`总价（售价）`、`单位`、`毛利率`、`库存sku`、`产品名称`、`售价(均价)`、`总价（售价(均价)）`。
- 说明未匹配库存 SKU 会进入 `未匹配` sheet，字段为 `库存sku`、`来源SP单号`、`数量`、`问题说明`。
- `success=false`：只转述 `exception`；不要重跑下载发货单 CLI。
