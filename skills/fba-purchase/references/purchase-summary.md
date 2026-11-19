# 采购汇总、批量备货单与正式合同

日常正式采购主入口。默认由 ERP 按 FIFO 计算历史留存抵扣、本次采购量、新合同号和新采购价；仅当用户明确要求先看文件不落库时使用 `--preview` 只读预览。

## 输入与参数

- `--delivery-no`：一个或多个 `SP` 开头的发货单号（多 SP 重复传），传入顺序即 ERP 跨 SP 分配库存的顺序。
- `--gross-margin`：毛利率，`0.2`～`0.5`。
- CSV 与总表要求：发货单 CSV 须包含 `MSKU`、`MSKU发货量`、`SKU发货量`（CLI 只上传每个 MSKU 的准确 `quantity_per_msku`）；正式和预览都要求 `供应商合同信息` 中的 `单位`、`合同产品名称`、`合同编号前缀`、`税率` 完整且无冲突。
- 长期资产：`master_xlsx`（出口退税总表）和 `contract_template_xlsx`（采购合同模板汇总）平时省略；仅本轮用户上传新版时才传 `--master-xlsx "<路径>"` / `--contract-template-xlsx "<路径>"`。

## 库存路线与预览规则

- **库存抵扣路线**：普通采购**必须省略** `--inventory-deduction-mode`，由 ERP 默认按 FIFO 使用留存库存。只有用户明确要求“不抵扣库存”“不使用留存库存”或“按计划全量采购”时才追加 `--inventory-deduction-mode none`；禁止根据库存量、金额或上下文自行推断，也不把库存路线变成每次固定询问的问题。
- **`none` 路线一致性**：`none` 会先做只读兼容性预检再提交（预检失败不得绕过或退回 FIFO）。预览、正式提交、未匹配 SKU 重试和批次替换必须持续携带 `--inventory-deduction-mode none`，不得携带 `--confirm-inventory-quote-id`；原批次是 FIFO 时不能通过替换改为 `none`，反之亦然。
- **`--preview` 预览**：仍须联网，按相同库存路线只读计算（不创建批次、不占库存、不保存报价、不占合同流水），不得与 `--confirm-inventory-quote-id` 同时使用；未匹配 SKU 确认和批次替换参数仍可携带。正式生成须重新执行不带 `--preview` 的原命令。

## 常用命令

```text
lxeskill fba purchase summary-create --delivery-no <SP1> --delivery-no <SP2> --gross-margin <毛利率>
```

- 按计划全量采购不扣库存：追加 `--inventory-deduction-mode none`
- 预览不落库：追加 `--preview`
- 上传新版长期资产时：追加 `--master-xlsx "<新版出口退税总表.xlsx>"` 或 `--contract-template-xlsx "<新版采购合同模板汇总.xlsx>"`

## ERP 交互确认

### 1. 未匹配 SKU 确认（`purchase_unmatched_sku_confirmation_required`）

1. 展示 `data.confirmation.items` 中每个 SP、库存 SKU、计划量和受影响 MSKU，说明确认后这些组件只保留 MSKU 结构，不参与采购、合同、FIFO 库存、装箱对账或留存。
2. 取得用户明确确认后，重跑原命令并追加 `--confirm-unmatched-sku-token <data.confirmation.token>`。
3. 若后续还需库存确认或批次替换，每次重试都须继续携带同一个 `--confirm-unmatched-sku-token`（若原命令有 `--inventory-deduction-mode none` 也必须继续携带）。
- `purchase_unmatched_sku_confirmation_stale`：输入集合已变，展示最新 `data.confirmation.items` 重新确认。
- `purchase_intent_no_tracked_stock_sku`：整批无可用跟踪 SKU，不会创建批次，报告摘要并停止。

### 2. 库存抵扣报价确认（`purchase_inventory_confirmation_required`）

1. 按以下统一中文格式展示 `data.erp.confirmation.affected_lines`，不得省略库存批次、当前余额、可用量或拟抵扣量；禁止把 `proposed_applied_quantity` 说成当前库存/原始数量/已抵扣数量，禁止仅按合同号合并不同来源 SP/`carryover_entry_id`，禁止用“ERP 原始数据”等无字段依据的解释：

```text
<供应商>｜<完整型号>｜计划 <planned_shipment_quantity>｜拟抵扣 <proposed_inventory_deduction_quantity>｜拟采购 <proposed_purchase_quantity>

库存来源：
- <source_contract_no> / <source_sp_no>：拟抵扣 <proposed_applied_quantity>
  当前剩余 <current_remaining_quantity> + 替代返还 <replacement_released_quantity> = 替代后可用 <available_after_release>；历史单价 <historical_tax_unit_price>
```

   非替代报价中 `replacement_released_quantity=0` 时，来源第二行改为“当前剩余 X；可用 X；历史单价 Y”（省略“替代返还 0”，其余字段仍必须保留）。
2. 说明 `data.erp.confirmation.omitted_unaffected_line_count` 是未发生库存抵扣、因此未展开的采购型号数（非数据截断）。
3. 末尾说明：“以上为待确认方案，当前库存尚未发生变化。”
4. 用户明确确认后，重跑原命令并追加 `--confirm-inventory-quote-id <data.erp.confirmation.quote_id>`。

- `purchase_inventory_quote_stale`：库存已变化，按同样规则展示最新 `affected_lines` 并重新确认，使用新 `quote_id`。

### 3. 批次替换与其他阻断

- `purchase_batch_replace_confirmation_required`：展示 `data.erp.confirmation.conflicts` 中的重复 SP 与当前批次；确认后追加 `--replace-batch-id`、`--expected-version-no` 和 `--change-reason`。
- `erp_inventory_deduction_mode_mismatch`：服务器未按请求确认“不扣库存”路线；停止，不得正式提交或回退 FIFO，先部署支持该路线的 ERP Server。

## 结果交付与异常恢复

- **预览结果**（`result_schema=lxe.fba.purchase-preview-result.v1`、`mode=preview`、`erp_read_only=true`、`batch_committed=false`）：发送 `terminal.files`，明确文件名含 `PREVIEW`、首表为“预览-未写入ERP”、合同号为占位符且无批次/正式合同 ID；提醒用户正式执行会重新计算，库存、价格和合同号可能变化，预览不能直接转正式批次。
- **正式结果**（`result_schema=lxe.fba.purchase-summary-result.v1`）：发送 `terminal.files`（采购汇总、各 SP 备货单、正式合同），报告 `batch_no`、`version_no`、`quantity_summary`、`contracts`（只含供应商、合同号、合同 ID 和路径）及必须转述的 `asset_sources.*`。
  - `inventory_deduction_mode`：`fifo` 表示“FIFO 抵扣”，`none` 表示“不扣库存”（需明确说明计划量全额采购、未使用现有留存）。
  - 含 `unmatched_summary` 时报告未匹配 SKU、MSKU 组件数和排除计划量，完整清单在采购汇总“未匹配”页。
  - `artifact_summary.contract_count < manufacturer_count` 属正常情况（供应商全由历史库存满足时不生成新合同）。
  - `purchase_line_count` 仅表示已处理型号行数，逐型号明细以采购汇总附件为准，不要因不含 `purchase_lines` 重跑。
  - 表格口径说明：正式文件将数量拆为 `计划发货量`、`本次采购量`、`留存库存抵扣量`；采购汇总与备货单把新采购行放前/上、历史库存按“旧合同号＋历史单价”拆黄行；正飞正式 `均价` 只按 `本次采购量` 加权。
- **`status=batch_committed_artifact_generation_failed`**：ERP 已提交但本地生成不完整。报告批次/合同 ID 和真实 `artifact_error`，先发送 `terminal.files` 中已生成的附件并标明缺失文件；恢复时用**完全相同**的正式命令重试（依赖确定性请求 ID 只补齐缺失附件，不得改参数另建批次）。
