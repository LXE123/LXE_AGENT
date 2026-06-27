---
name: fba-customs-declaration-fill
description: 根据用户上传的一个或多个备货 xlsx 填写报关资料模板，生成申报要素、报关单明细、发票、箱单、合同。用户要求填写报关单、报关资料、报关文件时使用。
type: amazon_fba
---

# Customs Declaration Fill

## Hard Rules

- 只使用固定 CLI。
- 不要手动编辑用户上传的 xlsx 或 `data/customs_declaration/custom_declaration_documents.xlsx`。
- 模板原件不能修改；CLI 会复制模板到 `artifacts/customs_declaration/` 后填写副本。
- CLI 会填写申报要素、报关单明细、发票、箱单、合同，并保留模板公式和默认字段。
- CLI 根据文件名里的 `SP...` 查找本地 WMS 装箱数据，用于计算毛重、净重和件数。
- CLI 会用本地 FBA 发货单 CSV 的 `MSKU` 和 `SKU发货量` 生成独立库存 SKU 数量校验报告；发货单只作为 MSKU 组成关系来源。
- 多个备货单会写入同一份报关资料；目的国必须一致，相同 SKU 不合并、不去重。
- 商品总数最多 50 行，超过时 CLI 会失败。
- 本 CLI 不自动下载 WMS 装箱数据或 FBA 发货单 CSV；缺少本地文件时只转述 CLI 结果。

## Required Input

- 至少一个用户提供的 `.xlsx` 备货单路径。
- 每个文件名必须包含 `SP...` 发货单号和目的国。
- 多文件目的国必须一致；仅支持 `日本`、`澳大利亚`、`德国`、`英国`、`美国`、`加拿大`。
- 本地必须已存在每个 SP 对应的装箱数据：`artifacts/mabang_wms_consignment/<SP单号>.xls|xlsx`。
- 本地最好已存在每个 SP 对应的 FBA 发货单 CSV：`artifacts/mabang_fba_delivery/<SP单号>_*.csv`；缺失时正式报关资料仍会生成，但数量校验报告会标记无法校验。

## Command

```powershell
uv run --frozen python -m services.agent_cli.mabang.fill_customs_declaration --input-xlsx <uploaded_xlsx_path>
```

多个备货单重复传参：

```powershell
uv run --frozen python -m services.agent_cli.mabang.fill_customs_declaration --input-xlsx <path_1> --input-xlsx <path_2>
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户报关资料文件已生成，并提供 `output_xlsx`。
- 始终检查 `validation_report_xlsx`、`quantity_validation_status` 和 `quantity_validation_summary`；数量不一致或无法校验时，把报告路径一并告诉用户。
- 可简要说明 `sp_nos`、`box_count`、`total_gross_weight`、`total_amount_upper`。
- `unmatched_count > 0`：提醒用户有未匹配申报规则的行，并转述 `notice`。
- `success=false`：只转述 `exception`。
