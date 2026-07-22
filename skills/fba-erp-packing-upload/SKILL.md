---
name: fba-erp-packing-upload
description: 将某个 SP 的原始完整 WMS 装箱数据上传到 FBA ERP，返回库存 SKU 实际发货量、计划量差异和留存量。用户要求上传真实发货量、同步装箱数据到 ERP、重新上传更正后的装箱量，或查询本次上传产生的 ERP 对账结果时使用；不要用于下载装箱文件、上传拆分装箱文件、生成采购单或采购合同。
type: amazon_fba
commands:
  - lxeskill fba erp packing-upload
---

# FBA ERP Packing Upload

## Hard Rules

- 必须通过 exec 调用 frontmatter 中声明的固定 CLI；禁止直接运行 Python 业务模块。
- 只提供 SP 号。CLI 固定从 WMS 下载目录查找 `SP号.xls` 或 `SP号.xlsx`，不要传入其他文件路径。
- 只上传原始完整装箱文件；禁止使用 `SP号-1.xlsx` 等拆分文件。
- 不读取发货单 CSV、备货单或采购表，不在本地推导 MSKU 对应的库存 SKU，也不在本地计算留存量。
- ERP 不可用时停止本次上传；不要排队、写本地影子数据或改走本地对账逻辑。
- 先检查 terminal 的 `ok`。成功时读取 `data`；失败时读取 `data.error`、`data.recovery` 和 terminal `error`。
- 失败时转述真实错误码和实际错误信息；不要用推测或通用提示覆盖。

## Required Input

- `ship_no`：必须是 `SP` 开头的发货号。

## Initial Command

```text
lxeskill fba erp packing-upload --ship-no <ship_no>
```

## Missing Original File

当 `data.error.code=packing_file_missing` 时：

1. 告诉用户本地缺少该 SP 的原始 WMS 装箱文件。
2. 询问用户是否现在下载；未取得同意前不要下载。
3. 用户同意后切换到 `fba-shipment-wms-box-download`，执行：

```text
lxeskill fba shipment wms-box-download --ship-no <ship_no> --split-mode original
```

4. 下载成功后重新执行 Initial Command。不要把下载逻辑复制进本 Skill。

## Replacement Confirmation

当 `data.error.code=packing_snapshot_replace_confirmation_required` 时：

1. 从 `data.error.detail.changes` 展示每个新增、删除或数量变化的 MSKU，并说明替换会重算 ERP 对账和未使用的留存量。
2. 询问用户是否确认替换；未取得明确确认前不要继续。
3. 用户确认后使用 `data.error.detail.current_snapshot_id` 执行：

```text
lxeskill fba erp packing-upload --ship-no <ship_no> --confirm-replace-snapshot-id <current_snapshot_id>
```

- 如果返回 `packing_snapshot_changed`，说明确认期间 ERP 当前版本已变化。展示这次返回的新差异并重新询问，不要沿用旧快照 ID。
- 如果返回 `carryover_already_applied`，说明旧快照的留存量已经被后续采购使用，不能替换；只转述服务器给出的真实原因。

## Result Handling

- `success=true`：上传已完成或业务数据未变化。报告 `batch_no`、`version_no`、`status`、`reconciliation_status` 和 `summary`。
- `status=unchanged` 或 `status=idempotent`：说明 ERP 没有新建装箱版本。
- `reconciliation_status=passed`：说明库存 SKU 计划量和实际量一致。
- `reconciliation_status=mismatch`：上传仍然成功；列出 `reconciliation_lines` 中的短缺、超发或缺失实际量，并报告留存量。
- `reconciliation_status=incomplete`：上传仍然成功；逐条转述 `reconciliation_lines` 中的真实问题，不能宣称对账完成。
- `reconciliation_lines_truncated>0`：明确说明省略了多少条，不要暗示结果完整。
- `reconciliation_detail_error` 非空：明确说明装箱快照已上传成功，但获取对账明细失败，并转述其中的真实错误。
- `sp_not_in_current_batch`：说明该 SP 尚不属于 ERP 当前采购批次；不要读取本地 CSV 兜底。
- 其他失败：报告 `data.error.code`、`data.error.message` 及可用的 `http_status`。
