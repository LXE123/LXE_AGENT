---
name: fba-purchase-summary-create
description: 根据一批本地 FBA 发货单 CSV、出口退税总表和毛利率，与 FBA ERP 交互并在本地生成采购汇总表、每个 SP 备货单和合同。默认创建正式采购批次；用户明确要求先看文件但不写入 ERP 时使用 --preview 只读预览。用户要求按一批 SP 生成采购汇总、批量备货单、合同或 ERP 采购批次时使用；不要用于上传 WMS 真实装箱量。
type: amazon_fba
commands:
  - lxeskill fba purchase summary-create
---

# FBA Purchase Summary Create

## Hard Rules

- 必须通过 exec 调用 frontmatter 中声明的固定 CLI；禁止直接运行 Python 业务模块。
- 发货单只从 `artifacts/fba/delivery_csv/<SP>_*.csv` 查找；缺失时转述真实错误，不自动下载。
- 默认是正式联网模式：本地上传计划需求和映射，ERP 计算库存抵扣、本次采购量、新合同号和新采购价。
- `--preview` 仍须联网，ERP 使用当前库存执行与正式模式相同的 FIFO、采购量、价格和来源分配计算；不创建批次、不占库存、不保存报价、不占合同流水。
- 未匹配 SKU 或 ERP 返回确认要求时不生成任何正式文件；先展示真实清单后询问用户。
- ERP 连接失败时停止；不得回退到旧本地草稿算法。
- `--draft` 已删除，不得调用或建议使用。
- `--preview` 不得与 `--confirm-inventory-quote-id` 同时使用；未匹配 SKU 确认和完整批次替换参数仍可携带。
- 不要手工解析 CSV 或编辑输出 Excel。

## Required Input

- `delivery_no`：一个或多个 `SP` 开头的发货单号，顺序就是 ERP 跨 SP 分配库存的顺序。
- `master_xlsx`：出口退税总表，由系统记忆，见下方「长期资产」。
- `contract_template_xlsx`：合同模板汇总，由系统记忆；正式和预览都需要。
- `gross_margin`：`0.2`～`0.5`。
- 正式和预览都要求发货单 CSV 包含 `MSKU`、`MSKU发货量`、`SKU发货量`；CLI 只上传每 1 个 MSKU 的准确 `quantity_per_msku`，不上传 MSKU 计划量。
- 正式和预览都要求 `供应商合同信息` 中的 `单位`、`合同产品名称`、`合同编号前缀`、`税率` 完整且无冲突。

## 长期资产（自动记忆）

- `master_xlsx`（出口退税总表）是**长期资产**：系统记住当前版，**平时不要传这个参数**。
- 只有用户在本轮对话里上传了新版本时才传它的绝对路径；CLI 会自动把它升为当前版，旧版留一份可回退。
- 用户没上传、系统也没存过时，CLI 会返回 `input_required`，这时才向用户索取。
- 结果里的 `asset_sources.master_xlsx` 必须转述给用户，例如「使用出口退税总表：xxx.xlsx（07-06 上传）」，让用户能发现用错了版本。
- `contract_template_xlsx`（采购合同模板汇总）也是**长期资产**：正式和预览都自动使用当前版，平时不要传参数；只有用户上传新版时才传绝对路径。
- 缺少合同模板时，CLI 会在请求 ERP 前返回 `input_required`。结果里的 `asset_sources.contract_template_xlsx` 也必须转述给用户。

## Commands

正式单 SP：

```text
lxeskill fba purchase summary-create --delivery-no <SP> --gross-margin <毛利率>
```

用户上传了新版本时（只有这种情况才传该参数）：

```text
lxeskill fba purchase summary-create --delivery-no <SP> --gross-margin <毛利率> --master-xlsx "<新版出口退税总表.xlsx>"
```

用户上传新版合同模板时追加 `--contract-template-xlsx "<新版采购合同模板汇总.xlsx>"`。

多 SP 重复传 `--delivery-no`。用户明确要求先生成完整文件但不写入 ERP 时追加：

```text
--preview
```

预览不是离线模式；不得携带 `--confirm-inventory-quote-id`。正式生成必须重新执行不带 `--preview` 的原命令。

## ERP Confirmation

当 `data.error.code=purchase_unmatched_sku_confirmation_required` 时：

1. 展示 `data.confirmation.items` 中每个 SP、库存 SKU、计划量和受影响 MSKU；明确这些组件确认后只保留 MSKU 结构，不参与采购、合同、FIFO 库存、装箱对账或结转。
2. 未取得用户明确确认前不要继续。
3. 确认后重试原命令，追加 `--confirm-unmatched-sku-token <data.confirmation.token>`。
4. 若后续还需库存确认或批次替换，后续每次重试都必须继续携带同一个 `--confirm-unmatched-sku-token`。

- `purchase_unmatched_sku_confirmation_stale`：发货 CSV、出口退税总表或未匹配集合已经变化；展示最新 `data.confirmation.items` 并重新确认，不能沿用旧 token。
- `purchase_intent_no_tracked_stock_sku`：整批没有可跟踪 SKU，CLI 不会创建 ERP 批次；报告真实未匹配摘要并停止。

当 `data.error.code=purchase_inventory_confirmation_required` 时：

1. 使用以下统一中文格式展示 `data.erp.confirmation.affected_lines`，不得省略库存批次、当前余额、可用量或拟抵扣量：

   ```text
   <供应商>｜<完整型号>｜计划 <planned_shipment_quantity>｜拟抵扣 <proposed_inventory_deduction_quantity>｜拟采购 <proposed_purchase_quantity>

   库存来源：
   - <source_contract_no> / <source_sp_no>：拟抵扣 <proposed_applied_quantity>
     当前剩余 <current_remaining_quantity> + 替代返还 <replacement_released_quantity> = 替代后可用 <available_after_release>；历史单价 <historical_tax_unit_price>
   ```

   非替代报价中 `replacement_released_quantity=0` 时，第二行改为“当前剩余 X；可用 X；历史单价 Y”，省略“替代返还 0”，但来源 SP、当前剩余、可用量和拟抵扣量仍必须展示。
2. 说明 `data.erp.confirmation.omitted_unaffected_line_count` 是未发生库存抵扣、因此未展开的采购型号数；不要把它说成数据截断。
3. 清单末尾必须说明：“以上为待确认方案，当前库存尚未发生变化。”未取得用户明确确认前不要继续。
4. 确认后重试原命令，追加 `--confirm-inventory-quote-id <data.erp.confirmation.quote_id>`。

禁止把 `proposed_applied_quantity` 称为当前库存、原始数量或已抵扣数量；禁止仅按合同号合并不同来源 SP/`carryover_entry_id` 的库存批次；禁止用“ERP 原始数据”等没有具体字段依据的说法解释库存状态。

- `purchase_inventory_quote_stale`：库存已变化，按相同规则展示 `data.erp.confirmation.affected_lines` 并重新询问，不沿用旧 quote ID；重试时使用 `data.erp.confirmation.quote_id`。
- `purchase_batch_replace_confirmation_required`：展示 `data.erp.confirmation.conflicts` 中的重复 SP 和当前批次；用户确认后使用 `--replace-batch-id`、`--expected-version-no` 和 `--change-reason`。

## Result Handling

- 正式成功结果使用 `result_schema=lxe.fba.purchase-summary-result.v1`。完整 ERP 分配已在 CLI 内部完成校验和制表，不会作为调试数据重复输出。
- 预览成功结果使用 `result_schema=lxe.fba.purchase-preview-result.v1`、`mode=preview`、`erp_read_only=true`、`batch_committed=false`。将 terminal `files` 一次发送；明确文件名含 `PREVIEW`、首个工作表为“预览-未写入ERP”、合同号是占位符，且没有批次 ID、正式合同 ID 或合同流水。
- 预览直接采用 ERP 当前建议库存，不要求库存报价二次确认。提醒用户正式执行会重新计算，库存、价格及合同编号可能变化；预览结果不能转成正式批次。
- `success=true`：将 terminal `files` 一次传给 `send_files(paths=<terminal.files>)`；附件包括本地生成的采购汇总、各 SP 备货单和正式合同。报告 `batch_no`、`version_no`、`quantity_summary` 和 `contracts`；`contracts` 只含供应商、合同号、合同 ID 和对应文件路径。
- 正式成功含 `unmatched_summary` 时，明确报告未匹配 SKU、MSKU 组件数和排除的计划量；完整清单仍查看采购汇总 Excel 的“未匹配”页。
- `artifact_summary.contract_count` 小于 `manufacturer_count` 可能是正常结果：某供应商全部由历史库存满足时不会生成新合同。不要据此声称合同缺失。
- `purchase_line_count` 只表示 ERP 已处理的型号行数；逐型号明细以采购汇总附件为准，不要因成功结果不含 `purchase_lines` 而重新执行命令。
- 正式采购汇总和备货单将 `数量` 拆为 `计划发货量`、`本次采购量`、`留存库存抵扣量`。
- 正式采购汇总不显示合同编号前缀；本次采购行置前且只写新合同号，历史库存按“旧合同号＋历史单价”拆行，以“旧合同号 × 抵扣量”标记，整行黄色并置于合计行之前。
- 备货单的新采购行在上方，使用新合同号；历史库存行在底部且整行黄色，使用旧合同号和历史单价。
- 同一型号使用多个旧合同时，每个“旧合同号＋历史单价”单独一条黄色行。
- 正飞正式 `均价` 只按 `本次采购量` 加权；黄色行不使用新均价。
- `status=batch_committed_artifact_generation_failed`：ERP 已提交但本地文件生成不完整。先报告批次/合同 ID 和真实 `artifact_error`，再发送 terminal `files` 中已经成功生成的附件，并明确哪些文件尚未生成。需要恢复时用完全相同的正式命令重试，让确定性请求 ID 只补齐缺失附件，不得改参数另建批次。
- 失败时转述 `error.code`、`error.message` 和可用的 `http_status/detail`，不要用通用提示覆盖。
