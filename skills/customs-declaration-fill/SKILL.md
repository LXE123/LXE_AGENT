---
name: customs-declaration-fill
description: 根据用户上传的一个或多个备货 xlsx 填写报关资料模板，生成申报要素、报关单明细、发票、箱单和合同已填好的报关资料文件。
type: amazon_store
---

## When to Use

- 用户发送一个或多个备货 xlsx，并要求“填写报关单”“填写报关资料”“生成报关资料”“把这些备货单写入同一个报关文件”等。
- 文件名通常类似 `4.26-SP260414001-新棱镜备货-美国（4.28）-2.xlsx`，其中 `SP260414001` 是发货单号，`美国` 是目的国。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.fill_customs_declaration`
- 不要手动编辑用户上传的 xlsx。
- 不要手动编辑 `data/customs_declaration/custom_declaration_documents.xlsx`。
- 模板原件不能修改，CLI 会复制模板到 `artifacts/customs_declaration/` 后填写副本。
- CLI 会填写 `申报要素` sheet，并补全 `报关单` sheet 的项号、单价、数量、单位、最终目的国、净重、毛重、件数。
- CLI 会按商品行数填充 `发票`、`箱单`、`合同` 三个 sheet 的公式行；`箱单` 的箱号和箱数本版不主动处理。
- CLI 会按所有输入备货单的 `总价` 列合计，生成中文大写金额，并写入 `发票` 和 `合同`。
- CLI 会删除多余未使用商品行，但保留少量空白：`报关单` 保留 2 个空商品块，`发票`、`箱单`、`合同` 保留 5 行空白商品行。
- CLI 删除未使用商品行后会同步调整打印区域和手动分页符，让分页预览范围跟删除后的内容一致。
- CLI 会根据文件名里的 `SP...` 查找本地装箱数据，用装箱数据计算毛重、净重和件数。
- 多个备货单会写入同一份报关资料；目的国必须一致，相同 SKU 不合并、不去重。
- 商品总数最多 50 行，超过 50 行时 CLI 会失败。
- 模板里的公式、合并单元格和其它默认字段由 CLI 保留，不要手动覆盖。
- 本 CLI 不会自动下载 WMS 装箱数据；本地缺少对应装箱数据时会失败。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Required Input

- 必须有至少一个用户提供的 `.xlsx` 文件路径。
- 单次报关资料最多包含 50 行商品。
- 每个文件名中必须包含 `SP...` 发货单号。
- 每个文件名中必须包含目的国，且多文件时目的国必须一致；仅支持：`日本`、`澳大利亚`、`德国`、`英国`、`美国`、`加拿大`。
- 本地必须已经存在每个 SP 对应的装箱数据 Excel，通常位于 `artifacts/mabang_wms_consignment/<SP单号>.xls` 或 `artifacts/mabang_wms_consignment/<SP单号>.xlsx`。
- 如果用户没有提供 xlsx 文件，先追问文件。

## How to Execute

固定执行：

```powershell
uv run --frozen python -m services.agent_cli.mabang.fill_customs_declaration --input-xlsx <uploaded_xlsx_path>
```

多个备货单固定重复传参：

```powershell
uv run --frozen python -m services.agent_cli.mabang.fill_customs_declaration --input-xlsx <uploaded_xlsx_path_1> --input-xlsx <uploaded_xlsx_path_2>
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "sp_no": "SP260414001",
  "sp_nos": ["SP260414001"],
  "destination_country": "美国",
  "input_xlsx": "...xlsx",
  "input_xlsx_paths": ["...xlsx"],
  "output_xlsx": "artifacts/customs_declaration/SP260414001_custom_declaration_documents.xlsx",
  "consignment_excel_path": "...xlsx",
  "consignment_excel_paths": {"SP260414001": "...xlsx"},
  "box_count": 12,
  "total_gross_weight": 43.8,
  "total_amount": 28882.155,
  "total_amount_upper": "人民币贰万捌仟捌佰捌拾贰圆壹角伍分伍厘",
  "row_count": 12,
  "customs_detail_row_count": 12,
  "formula_sheet_row_count": 12,
  "formula_sheets": {"发票": 12, "箱单": 12, "合同": 12},
  "unmatched_count": 1,
  "notice": ["第5行未匹配申报规则: 商品名称=..., 品名=..."],
  "source": "customs_declaration_fill"
}
```

失败时：

```json
{
  "success": false,
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户报关资料文件已生成，并提供 `output_xlsx`。
- 告诉用户已补全目的国、毛重、净重、件数，并已填充 `发票`、`箱单`、`合同` 的公式行，多余未使用商品行已删除且保留少量空白，打印区域也已同步；可以简要说明 `box_count`、`total_gross_weight` 和 `total_amount_upper`。
- 多备货单时，告诉用户已合并的 `sp_nos`，并说明相同 SKU 未合并。
- 如果 `unmatched_count > 0`，提醒用户有未匹配申报规则的行，并转述 `notice`。
- `success=false`：只转述 `exception`。
