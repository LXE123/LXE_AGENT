---
name: fba-purchase-summary-create
description: 根据一批本地 FBA 发货单 CSV、用户提供的出口退税总表和毛利率，默认与 FBA ERP 交互，预览并确认 FIFO 历史库存抵扣后生成正式采购汇总表和每个 SP 备货单；用户明确要求离线或草稿时使用 --draft。用户要求按一批 SP 生成采购汇总、批量备货单或 ERP 采购批次时使用；不要用于上传 WMS 真实装箱量。
type: amazon_fba
commands:
  - lxeskill fba purchase summary-create
---

# FBA Purchase Summary Create

## Hard Rules

- 必须通过 exec 调用 frontmatter 中声明的固定 CLI；禁止直接运行 Python 业务模块。
- 发货单只从 `artifacts/mabang_fba_delivery/<SP>_*.csv` 查找；缺失时转述真实错误，不自动下载。
- 默认是正式联网模式：本地上传计划需求和映射，ERP 计算库存抵扣、本次采购量、新合同号和新采购价。
- ERP 返回确认要求时不生成任何正式文件；先展示真实库存来源后询问用户。
- 正式模式连接 ERP 失败时停止；不得自动改走草稿。
- `--draft` 不访问 ERP、不占用库存、不创建批次或正式合同号；不得与确认/替换参数同时使用。
- 不要手工解析 CSV 或编辑输出 Excel。

## Required Input

- `delivery_no`：一个或多个 `SP` 开头的发货单号，顺序就是 ERP 跨 SP 分配库存的顺序。
- `master_xlsx`：用户提供的出口退税总表。
- `gross_margin`：`0.2`～`0.5`。
- 正式模式要求发货单 CSV 包含 `MSKU`、`MSKU发货量`、`SKU发货量`；CLI 只上传每 1 个 MSKU 的准确 `quantity_per_msku`，不上传 MSKU 计划量。
- 正式模式要求 `供应商合同信息` 中的 `单位`、`合同产品名称`、`合同编号前缀`、`税率` 完整且无冲突。

## Commands

正式单 SP：

```text
lxeskill fba purchase summary-create --delivery-no <SP> --master-xlsx "<出口退税总表.xlsx>" --gross-margin <毛利率>
```

多 SP 重复传 `--delivery-no`。用户明确要求草稿/离线时追加：

```text
--draft
```

## ERP Confirmation

当 `data.error.code=purchase_inventory_confirmation_required` 时：

1. 展示 `data.erp.lines` 中每个型号的计划量、建议抵扣量和本次采购量；从 `inventory_sources` 逐条展示旧合同号、历史单价、可用量和建议使用量。
2. 未取得用户明确确认前不要继续。
3. 确认后重试原命令，追加 `--confirm-inventory-quote-id <data.erp.quote_id>`。

- `purchase_inventory_quote_stale`：库存已变化，展示 `data.erp.latest_quote` 并重新询问，不沿用旧 quote ID。
- `purchase_batch_replace_confirmation_required`：展示重复 SP 和当前批次；用户确认后使用 `--replace-batch-id`、`--expected-version-no` 和 `--change-reason`。

## Result Handling

- `success=true`：对 terminal `files` 中的每个附件调用 `send_file`，并报告 `batch_no`、`version_no`、`contracts`、`purchase_lines`。
- 正式采购汇总和备货单将 `数量` 拆为 `计划发货量`、`本次采购量`、`留存库存抵扣量`。
- 备货单的新采购行在上方，使用新合同号；历史库存行在底部且整行黄色，使用旧合同号和历史单价。
- 同一型号使用多个旧合同时，每个“旧合同号＋历史单价”单独一条黄色行。
- 正飞正式 `均价` 只按 `本次采购量` 加权；黄色行不使用新均价。
- `status=batch_committed_artifact_generation_failed`：ERP 已提交但本地文件失败。报告批次/合同 ID，不得当作网络失败重新创建。
- `mode=draft`：明确说明文件名含 `DRAFT`、工作表含“草稿-未同步ERP”、没有正式合同号。
- 失败时转述 `error.code`、`error.message` 和可用的 `http_status/detail`，不要用通用提示覆盖。
