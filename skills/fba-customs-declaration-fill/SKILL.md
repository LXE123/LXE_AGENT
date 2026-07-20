---
name: fba-customs-declaration-fill
description: 根据用户上传的一个或多个备货 xlsx、本地 FBA 发货单 CSV 和本地 WMS 装箱数据填写报关资料模板，按 WMS 实际发货量生成申报要素、报关单明细、发票、箱单、合同和库存 SKU 数量校验报告。用户要求填写报关单、报关资料、报关文件时使用。
type: amazon_fba
commands:
  - lxeskill fba customs fill
---

# Customs Declaration Fill

## Hard Rules

- 必须通过 exec 调用 frontmatter commands 中声明的 lxeskill 命令；禁止直接执行对应 Python 业务模块。
- 下方均为真实 shell 命令；简单参数使用 flags，复杂对象写入 JSON 文件后使用 --input-json。
- 先检查 terminal 的 `ok`；成功时读取 `data` 和 `files`，失败时读取 `error.message` 及可选的 `data.context`。

- 只使用固定 CLI。
- 不要手动编辑用户上传的备货单或报关资料模板。
- 备货单和模板都必须来自当前对话附件；只使用附件下载结果中的真实绝对路径。禁止猜测路径、扫描系统目录或使用安装目录内的模板。
- 任一必需附件缺失时停止执行并向用户索取文件，不要调用 CLI。
- 模板原件不能修改；CLI 会复制模板到 `artifacts/customs_declaration/` 后填写副本。
- CLI 会填写申报要素、报关单明细、发票、箱单、合同，并保留模板公式和默认字段。
- CLI 根据文件名里的 `SP...` 查找本地 WMS 装箱数据；WMS `装箱数量` 是正式报关资料的实际发货量来源，同时用于计算毛重、净重和件数。
- CLI 必须使用本地 FBA 发货单 CSV 的 `MSKU` 和 `SKU发货量` 解析 `MSKU -> 库存 SKU` 组成关系；发货单 CSV 不作为实际发货量来源。
- 备货单第一个表格提供 `库存 SKU -> 规则型号` 映射；汇总表 `SKU` 作为型号组代表行，汇总表继续提供申报属性、售价、单位等字段。
- 正式报关资料按 WMS 实际发货量填写，不按汇总表预期发货量填写；实际发货量为 0 的申报行不写入正式报关资料。
- CLI 会生成独立库存 SKU 数量校验报告，报告包含 `数量校验`、`汇总表计算前后对比`、`数据来源`。
- 多个备货单会写入同一份报关资料；目的国必须一致，相同 SKU 不合并、不去重。
- 商品总数最多 50 行，超过时 CLI 会失败。
- 本 CLI 不自动下载 WMS 装箱数据或 FBA 发货单 CSV；缺少本地文件时只转述 CLI 结果。

## Required Input

- 至少一个用户提供的 `.xlsx` 备货单路径。
- 一个用户提供的 `.xlsx` 报关资料模板路径。
- 每个文件名必须包含 `SP...` 发货单号和目的国。
- 多文件目的国必须一致；仅支持 `日本`、`澳大利亚`、`德国`、`英国`、`美国`、`加拿大`。
- 本地必须已存在每个 SP 对应的装箱数据：`artifacts/mabang_wms_consignment/<SP单号>.xls|xlsx`。
- 本地必须已存在每个 SP 对应的 FBA 发货单 CSV：`artifacts/mabang_fba_delivery/<SP单号>_*.csv`。

## Command

```text
lxeskill fba customs fill --input-xlsx <uploaded_xlsx_path> --template-xlsx <uploaded_template_xlsx_path>
```

多个备货单重复传参：

```text
lxeskill fba customs fill --input-xlsx <path_1> --input-xlsx <path_2> --template-xlsx <uploaded_template_xlsx_path>
```

只把最后一条 `type="result"` 记录作为 terminal；业务字段位于 `data`，附件位于 `files`。

## Result Handling

- `success=true`：告诉用户报关资料文件已生成，并提供 `output_xlsx`；确认 `quantity_basis=actual`。
- terminal `files` 中只有正式报关资料；非空时逐个调用 `send_file`。校验报告属于诊断文件，不主动发送。
- 始终检查 `validation_report_xlsx`、`quantity_validation_status` 和 `quantity_validation_summary`；数量不一致或无法校验时，把报告路径一并告诉用户。
- 简要说明数量校验报告包含 `数量校验`、`汇总表计算前后对比`、`数据来源`，可用于查看期望发货量、实际发货量、MSKU 来源和汇总表前后差异。
- 可简要说明 `sp_nos`、`box_count`、`total_gross_weight`、`total_amount_upper`。
- `unmatched_count > 0`：提醒用户有未匹配申报规则的行，并转述 `notice`。
- `success=false`：只转述 `exception`。
