# 单 SP 备货单生成（兼容入口）

仅当用户明确要求按**单个 SP** 独立生成备货单、且不需要一批 SP 的正飞统一均价和正式合同时使用。处理一批 SP、需要扣减 ERP FIFO 库存或需要正式合同时，必须改用 [采购汇总与合同](purchase-summary.md)。

## 输入与命令

- `--delivery-no`：单个 `SP` 发货单号，只从本地 `artifacts/fba/delivery_csv/<SP>_*.csv` 查找；缺失时直接报告错误，不自动下载。
- `--gross-margin`：`0.2`～`0.5`。
- `master_xlsx`（出口退税总表）：长期资产，平时不传，仅上传新版时传 `--master-xlsx`。须包含 `SKU表`（列名 `库存sku` 或 `库存SKU`）和 `供应商合同信息`（用 `供货方` 匹配 `SKU表` 的 `厂家`，读取 `单位`、`合同产品名称`、`税率`）。

```text
lxeskill fba restock workbook-create --delivery-no <SP> --gross-margin <毛利率>
lxeskill fba restock workbook-create --delivery-no <SP> --gross-margin <毛利率> --master-xlsx "<新版出口退税总表.xlsx>"
```

## 结果处理

- 交付 `output_xlsx`（通过 `send_files(paths=<terminal.files>)`），必须转述 `asset_sources.master_xlsx`。
- 简要转述 `sku_count`、`sku_source_count`、`matched_sku_count`、`unmatched_sku_count`、`manufacturer_count`、`contract_mapping_count`。
- 若 `warnings` 非空必须全部转述，尤其是“不同厂家有相同型号”、CSV `国家` 缺失/为空/多国，或 `供应商合同信息` 映射缺失/冲突，提醒业务核查。
- 业务口径说明：输出文件名为 `M.D-<SP>-新棱镜备货-<国家>.xlsx`，含 `备货单` 和 `未匹配` 两个 sheet（不生成厂家分类 sheet）；`售价 = 原价 / 含税倍率 / (1 - 毛利率)`；正飞 `均价` 仅按当前单 SP 计算。
