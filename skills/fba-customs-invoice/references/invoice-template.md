# 发票导入模板填写（invoice_Template）

根据上传的单个 SP 备货单、本地 FBA 发货单 CSV 和本地 WMS 装箱数据，按 WMS 分箱实际发货量生成 `invoice_Template` 和数量校验报告。

## 输入与口径

- **备货单 `.xlsx`**：单个 SP，文件名必须含 `SP...` 单号和目的国；第一个表格提供 `库存 SKU -> 规则型号` 映射，汇总表 `SKU` 作为型号组代表行（不按汇总表预期 `发货量` 填正式数量）。
- **本地 FBA 发货单 CSV**（`artifacts/fba/delivery_csv/<SP单号>_*.csv`）：只提供 `MSKU -> 库存 SKU` 组成关系。
- **本地 WMS 装箱数据 Excel**：`装箱数量` 是发票模板的实际发货量来源。
- **不自动补下载**：默认使用本地已有发货单 CSV 和 WMS 装箱数据（若用户显式指定文件，可传 `--delivery-csv` / `--consignment-excel`）；任一必需附件缺失时先追问用户，不启动 CLI，CLI 因缺本地文件失败时直接转述原因。
- **输出规则**：明细按 `箱号 + 汇总表代表 SKU` 写入，实际发货量为 0 的代表行不写入模板；产品图片来自库存 SKU Excel 的 `库存sku图片`；材质、用途、申报价规则无法匹配时通过 `notice` 提示。

## 命令

```text
lxeskill fba invoice fill --input-xlsx <备货单.xlsx>
```

- 本轮用户上传新版发票模板时追加 `--template-xlsx <新版发票模板.xlsx>`（平时不传）。
- 用户显式指定发货单或装箱文件时可追加 `--delivery-csv <路径>` / `--consignment-excel <路径>`。

## 结果处理

- `success=true`：提供 `output_xlsx`，确认 `quantity_basis=actual`，转述 `asset_sources.template_xlsx`（如「使用发票模板：xxx.xlsx（07-06 上传）」）。
- 通过 `send_files(paths=<terminal.files>)` 发送正式发票（`terminal.files` 仅含正式发票；校验报告和库存 SKU 中间文件不主动发送）。
- 如有 `validation_report_xlsx`，告知用户数量校验报告已生成（含 `数量校验`、`汇总表计算前后对比`、`数据来源`）。
- 简要转述 `invoice_row_count`、`box_count`、`image_missing_count`；`notice` 非空时转述缺图或缺失申报价规则提示。
- `success=false`：只转述真实 `exception` / `error.message`。
