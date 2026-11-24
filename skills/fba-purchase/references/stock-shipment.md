# 仅用留存库存发货（独立建单）

用户明确要求**仅用 ERP 留存库存**为仓库已有 SP 发货、不发生新采购时使用。若需合并新采购、输出采购汇总/备货单/正式合同，改用 [采购汇总与合同](purchase-summary.md)。

## 适用场景与数据源

- 只读取各 SP 的本地最新发货单 CSV（`artifacts/fba/delivery_csv/<SP>_*.csv`，须包含 `MSKU`、`MSKU发货量`、`SKU发货量` 及国家；缺失时直接报告错误，不自动下载）。
- **不需要**出口退税总表（`master_xlsx`）、合同模板（`contract_template_xlsx`）或毛利率，也**不生成**本地采购汇总表、备货单或合同 Excel。
- ERP 根据历史有效采购记录自动匹配每个库存 SKU 的供应商与型号，按供应商和型号汇总需求（`inventory_deduction_mode="stock_only"`）。

## 第一步：获取库存报价

```text
lxeskill fba stock-shipment create --delivery-no <SP1> --delivery-no <SP2>
```

- `--delivery-no` 可重复传入多张不重复的 SP 单号；CLI 按 SP 独立向 ERP 询价（每张 SP 一单互不阻塞）。
- 逐单检查 `data.items` 并展示结果：
  - `status=confirmation_required`：逐单展示库存报价（`confirmation.quote_id`）、库存来源批次及拟抵扣数量，询问用户是否确认。
  - 缺口或失败（如 `stock_shipment_insufficient_inventory`）：逐单展示缺口明细（`error.detail.shortages` 中的型号与缺口量）。
  - 若库存 SKU 无对应有效采购记录或同时对应多个供应商或型号，原样展示 ERP 返回的 SKU 和原因，该 SP 整单停止。

## 第二步：确认建单

用户明确确认要建单的 SP 后，传入对应的 `--delivery-no` 和 `--confirm-quote <SP>=<quote_id>`（多张可重复传 `--confirm-quote`）：

```text
lxeskill fba stock-shipment create --delivery-no <SP1> --delivery-no <SP2> --confirm-quote <SP1>=<quote_id_1>
```

- 每次 `--confirm-quote` 必须对应本次 `--delivery-no` 中的唯一 SP，格式为 `SP号=报价UUID`。
- 若因库存变化导致报价过期，按新返回重新展示报价并再次确认。
- 逐单报告结果：已生成的 `batch_no`（`status=created`/`idempotent`）、仍待确认的 SP 与缺货/报错的 SP。
- 遇到网络中断时，使用完全相同的输入重试（CLI 使用确定性 `request_id` 保证幂等）。
- 后续仓库发货后的实发量对账与留存结算，仍按 [实发上传与对账](packing-upload.md)（`lxeskill fba erp packing-upload`）执行。
