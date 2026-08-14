---
name: fba-erp-packing-upload
description: 预览并确认某个 SP 的原始完整 WMS 装箱数据，确认后上传到 FBA ERP 并生成库存 SKU 对账与留存库存。用户发送装箱 Excel、要求上传真实发货量、同步装箱数据、更正装箱量或查看留存预览时使用；不要用于下载装箱文件、上传拆分文件、生成采购单或采购合同。
type: amazon_fba
commands:
  - lxeskill fba erp packing-upload
---

# FBA ERP Packing Upload

## Hard Rules

- 必须通过 exec 调用 frontmatter 中声明的固定 CLI；禁止直接运行 Python 业务模块或调用 ERP API。
- 用户上传附件时，把桌面提供的真实附件绝对路径传给 `packing_excel`；不要要求用户复制路径，也不要猜测路径。
- 没有附件时可仅传 `ship_no`，CLI 会从 WMS 下载目录查找原始文件。
- 只允许原始完整的 `SP号.xls` 或 `SP号.xlsx`；禁止 `SP号-1.xlsx` 等拆分文件。
- 不在本地推导库存 SKU、留存量或合同来源；只展示 ERP 返回的正式预览。
- 首次上传和数据变更都必须等待用户明确确认。禁止在同一轮首次调用后自动携带 quote 提交。
- ERP 不可用时停止，不排队、不写本地影子数据，也不改走本地对账。
- 先检查 terminal 的 `ok`。失败时转述真实错误码和实际错误信息，不得用推测覆盖。

## Initial Preview

用户发送附件时：

```text
lxeskill fba erp packing-upload --packing-excel <附件真实绝对路径> [--ship-no <ship_no>]
```

没有附件、但原始文件已下载时：

```text
lxeskill fba erp packing-upload --ship-no <ship_no>
```

`ship_no` 与附件文件名不一致时停止并报告错误。不得忽略校验或改名后重试。

## Preview Presentation

当 `data.status=confirmation_required` 或 `quote_stale`：

1. 说明文件名、SP、SHA-256，以及预计动作是“首次上传”还是“替换现有版本”。
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

## Missing Original File

当 `data.error.code=packing_file_missing` 且本次没有附件时：

1. 告诉用户本地缺少该 SP 的原始 WMS 文件。
2. 询问是否下载；未取得同意前不要下载。
3. 用户同意后切换到 `fba-shipment-wms-box-download`，使用 `--split-mode original` 下载，再重新预览。

## Result Handling

- `reconciliation_status=passed`：库存 SKU 计划量和实际量一致。
- `mismatch`：列出短缺、超发或缺失实际量；确认后仍可正式写入。
- `incomplete`：逐条转述真实问题，不能宣称对账完成。
- `reconciliation_lines_truncated>0`：明确说明省略条数。
- `reconciliation_detail_error` 非空：说明正式确认已完成，但获取对账明细失败，并转述真实错误。
- `sp_not_in_current_batch`：说明 SP 尚不属于 ERP 当前采购批次，不读取本地 CSV 兜底。
- 其他失败：报告 `data.error.code`、`data.error.message` 及可用的 `http_status`。
