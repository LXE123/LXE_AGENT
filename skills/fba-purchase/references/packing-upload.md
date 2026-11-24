# 实发量上传 ERP 预览与确认

读取 FBA 发货单 CSV 的 `MSKU发货量` 列，向 ERP 预览并确认写入装箱快照，展开库存 SKU 对账与留存库存结算（归还多扣库存或生成新增留存）。

## 数据源与预览命令

- **使用指定文件/修订版**：用户提供发货单附件、指定路径或确认使用修订版时，传 `--delivery-csv` 实际路径。CSV 只需包含 `MSKU` 和 `MSKU发货量` 列（不强制要求 `SKU发货量`）；若保留 `发货单号` 列，CLI 会逐行核对与 `--ship-no` 一致。未发的 MSKU 可填 `0`（预览时跳过）；空值、非数字或负数会报 `delivery_csv_invalid` 并指出行号。

```text
lxeskill fba erp packing-upload --ship-no <ship_no> --delivery-csv "<发货单 CSV 路径>"
```

- **按 SP 自动查找**：只提供 SP 号时，CLI 从本地发货单目录按修改时间取该 SP 最新的一份（同样校对表内 `发货单号` 列）。

```text
lxeskill fba erp packing-upload --ship-no <ship_no>
```

- **待装箱 SP 整单不发**：用户明确整单不发且已确认货物全部到仓留存时，无需本地 CSV，按指定 SP 直接人工申报零实发预览：

```text
lxeskill fba erp packing-upload --ship-no <SP> --all-unshipped
```

  - `--all-unshipped` 仅用于首次预览，不能与 `--delivery-csv`、`--confirm-identical` 或 `--confirm-packing-quote-id` 同时传入。
  - 若该 SP 已有装箱对账（`packing_already_recorded`）或存在人工调整/留存已被下游采购使用（`packing_has_manual_adjustments`、`carryover_already_applied`），指引用户进入 FBA ERP 当前对账详情处理。确认首次零实发后如需撤销，指引从 ERP 的“撤销装箱数据”进入。

- 首次上传和数据变更都必须等待用户明确确认，禁止在同一轮首次调用后自动携带 quote 提交；确认时只单独使用 `--confirm-packing-quote-id <quote_id>`，不得同时传 `--delivery-csv` 或 `--all-unshipped`。

## 预览展示（`confirmation_required` / `quote_stale`）

`quote_stale` 表示确认期间 ERP 状态发生变化，必须按新返回重做完整展示并重新询问，不能沿用旧 quote。

1. 说明 SP、来源和预计动作（“首次上传”还是“替换现有版本”）：
   - 常规上传展示来源路径 `source_file_path`（如有）、文件名和 SHA-256；整单不发（`source_kind=all_unshipped`）展示“人工申报：整单不发”。
   - `packing_sp_no` 非空时，必须显示 `采购 SP <purchase_sp_no> → 装箱 SP <packing_sp_no>`。
   - `packing_sp_no` 为空时，只显示采购 SP，不重复两个相同编号。
2. 展示 `summary` 中的计划量、实际量、差异量和预计留存量。
3. 将 `proposed_carryovers` 原样展示为以下 8 列（服务端已按全部字段聚合，禁止再按合同号或型号合并；空字段保持为空，不猜测）：

```text
留存类型｜库存 SKU｜供应商｜采购订单号｜订单号｜型号｜含税单价｜数量
```

   - `packing_restore` → `归还库存`；`packing_new` → `新增留存`
   - `source_contract_no` → `采购订单号`；`source_sp_no` → `订单号`
   - `proposed_carryovers` 为空时明确说明“预计无留存库存”。
4. 若 `reconciliation_status=mismatch` 或 `incomplete`，一并展示真实对账问题。
5. 明确说明当前尚未写入装箱快照或库存，询问用户是否确认。

## 特殊拦截：`packing_identical_to_plan`

1. 说明本次发货单的实发量与 ERP 计划完全一致。
2. 询问用户仓库是否确实按计划如数发货。
3. 仅在用户明确确认后，追加 `--confirm-identical` 重跑同一预览命令。

## 确认提交与结果处理

用户明确确认当前预览后执行：

```text
lxeskill fba erp packing-upload --confirm-packing-quote-id <quote_id>
```

- 状态处理：
  - `created`：报告批次号、装箱版本、对账状态、实际留存明细和注意项。
  - `unchanged`：说明 ERP 当前数据与文件业务数量一致，未创建新版本，无需再次确认。
  - `idempotent`：说明相同确认已成功处理，未重复写入。
  - `packing_snapshot_quote_not_pending`：quote 已使用、过期或不属于当前流程，重新执行预览。
  - `carryover_already_applied`：旧快照留存已被下游采购使用，不能替换；逐项转述服务端返回的依赖业务。
- 对账与错误状态：
  - `reconciliation_status=passed`：库存 SKU 计划量与实际量一致。
  - `mismatch`：列出短缺、超发或缺失实际量；确认后仍可正式写入。
  - `incomplete`：逐条转述真实问题，不能宣称对账完成。
  - `reconciliation_lines_truncated>0`：明确说明省略条数；`reconciliation_detail_error` 非空：说明确认已完成但获取对账明细失败并转述错误。
  - `sp_not_in_current_batch`：说明 SP 尚不属于 ERP 当前采购批次，不读本地 CSV 兜底。
  - `packing_sp_alias_required`：说明采购 SP 已绑定专用装箱 SP，从 `error.detail.required_packing_sp_no` 原样展示正确编号并提示改用该编号重试（不得继续用采购 SP 上传）。
- **缺少发货单 CSV**：
  - 显式指定 `--delivery-csv` 找不到时，展示报错中的路径，请用户核对路径或重新提供。
  - 按 SP 自动查找返回 `delivery_csv_missing` 时，告知用户本地缺少该 SP 发货单 CSV 并询问是否下载；取得同意后切换到 `mabang-delivery-data` 下载，再重新预览。
