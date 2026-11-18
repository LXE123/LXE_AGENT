---
name: fba-erp-packing-upload
description: 使用用户指定的 FBA 发货单 CSV，或按 SP 号读取本地最新发货单，预览实发量并在确认后上传到 ERP。用户要求上传或更正真实发货量、同步发货数据、查看库存 SKU 对账或留存预览时使用。
type: amazon_fba
commands:
  - lxeskill fba erp packing-upload
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# FBA ERP Packing Upload

## Hard Rules

- 必须通过 exec 调用 frontmatter 中声明的固定 CLI；禁止直接运行 Python 业务模块或调用 ERP API。
- 实发量取自 FBA 发货单 CSV 的 `MSKU发货量` 列。可以使用用户核对并更正过的发货单。马帮 WMS 装箱 Excel 用于创建货件、报关和发票。
- 不在本地推导库存 SKU、留存量或合同来源；只展示 ERP 返回的正式预览。
- 首次上传和数据变更都必须等待用户明确确认。禁止在同一轮首次调用后自动携带 quote 提交。
- ERP 不可用时停止，不排队、不写本地影子数据，也不改走本地对账。
- 先检查 terminal 的 `ok`。失败时转述真实错误码和实际错误信息，不得用推测覆盖。

## Initial Preview

用户指定文件、提供发货单附件或已确认本轮修订版时，使用该文件的实际路径。保留发货单表头 `MSKU`、`MSKU发货量` 和 `SKU发货量`。用户确认未发的 MSKU 可以填 0，预览时 CLI 会跳过这些行。

```text
lxeskill fba erp packing-upload --ship-no <ship_no> --delivery-csv "<发货单 CSV 路径>"
```

只给 SP 号时，CLI 从本地发货单目录按修改时间取该 SP 最新的一份。

```text
lxeskill fba erp packing-upload --ship-no <ship_no>
```

## Preview Presentation

当 `data.status=confirmation_required` 或 `quote_stale`：

1. 展示本次预览的来源路径 `source_file_path`（如有）、文件名、SP、SHA-256，以及预计动作是“首次上传”还是“替换现有版本”。
   - `packing_sp_no` 非空时，必须明确显示 `采购 SP <purchase_sp_no> → 装箱 SP <packing_sp_no>`。
   - `packing_sp_no` 为空时只显示采购 SP，不重复两个相同编号。
2. 展示 `summary` 中的计划量、实际量、差异量和预计留存量。
3. 将 `proposed_carryovers` 展示为以下 8 列；服务端已按全部字段聚合，禁止再次按合同号或型号合并：

```text
留存类型｜库存 SKU｜供应商｜采购订单号｜订单号｜型号｜含税单价｜数量
```

- `packing_restore` 显示为“归还库存”。
- `packing_new` 显示为“新增留存”。
- `source_contract_no` 显示在“采购订单号”。
- `source_sp_no` 显示在“订单号”。
- 空字段保持为空，禁止猜测合同号、SP 或单价。
- `proposed_carryovers` 为空时明确说明“预计无留存库存”。

4. 若 `reconciliation_status=mismatch` 或 `incomplete`，同时展示真实对账问题。
5. 明确说明当前尚未写入装箱快照或库存，并询问用户是否确认。

当 CLI 返回 `error.code=packing_identical_to_plan` 时：

1. 说明本次发货单的实发量与 ERP 计划完全一致。
2. 询问用户仓库是否确实按计划如数发货。
3. 用户明确确认后，才追加 `--confirm-identical` 重跑同一条命令；未确认前不要自行添加该参数。

`quote_stale` 表示确认期间 ERP 状态变化；必须展示这次返回的新预览并重新询问，不能沿用旧 quote。

## Confirmation

只有用户明确确认当前预览后，才能执行：

```text
lxeskill fba erp packing-upload --confirm-packing-quote-id <quote_id>
```

- `created`：报告批次号、装箱版本、对账状态、实际留存明细和注意项。
- `unchanged`：说明 ERP 当前数据与文件业务数量一致，没有创建新版本，也不需要确认。
- `idempotent`：说明相同确认已成功处理，没有重复写入。
- `packing_snapshot_quote_not_pending`：quote 已使用、过期或不属于当前流程，重新执行 Initial Preview。
- `carryover_already_applied`：旧快照留存已被下游采购使用，不能替换；逐项转述服务器返回的依赖业务。

## Missing Delivery CSV

指定的文件找不到时，展示报错中的路径，请用户核对路径或重新提供该发货单。

按 SP 自动查找时，如返回 `data.error.code=delivery_csv_missing`：

1. 告诉用户本地缺少该 SP 的发货单 CSV。
2. 询问是否下载；未取得同意前不要下载。
3. 用户同意后切换到 `mabang-delivery-export` 下载，再重新预览。

## Result Handling

- `reconciliation_status=passed`：库存 SKU 计划量和实际量一致。
- `mismatch`：列出短缺、超发或缺失实际量；确认后仍可正式写入。
- `incomplete`：逐条转述真实问题，不能宣称对账完成。
- `reconciliation_lines_truncated>0`：明确说明省略条数。
- `reconciliation_detail_error` 非空：说明正式确认已完成，但获取对账明细失败，并转述真实错误。
- `sp_not_in_current_batch`：说明 SP 尚不属于 ERP 当前采购批次，不读取本地 CSV 兜底。
- `packing_sp_alias_required`：说明这个采购 SP 已设置专用装箱 SP，从 `error.detail.required_packing_sp_no` 原样展示正确编号，并提示使用该编号重新运行 `--ship-no`；不得继续用采购 SP 上传。
- 其他失败：报告 `data.error.code`、`data.error.message` 及可用的 `http_status`。
