# L3 command contract deviations

状态：Current

日期：2026-07-14

## 背景

L3 catalog 驱动测试在不修改生产模块和 `catalog.json` 的前提下，对所有 module 型命令检查统一 `run(arguments)` 入口，并根据顶层 `input_schema.required` 自动生成缺参用例。本记录列出取证时发现、但不在本轮顺手修复的现有差异。

## 已知差异

以下 shipment stage 命令缺少 `context_file` 时沿用 workflow envelope，返回 `params_ready=False`、`finished=False` 和 `exception`，而不是其他业务模块常用的 `success=False` 或 `ok=False`：

- `fba shipment confirm-own-carrier`
- `fba shipment enter-tracking-codes`
- `fba shipment prepare-multi-box`
- `fba shipment prepare-upload`

contract runner 只为这四个明确命令断言 `params_ready=False`，没有把全局失败合同放宽为任意 false-like 字段。

以下 module 的实际参数组合比 catalog 顶层 `required` 更严格，因此不会由顶层 required 自动用例完整覆盖：

- `fba msku detail-download`：模块要求 `ship_no` 或 `delivery_no`，catalog 未声明 `required`/`oneOf`。
- `replenish msku download`：模块要求 `store_id`、`id_type` 和 `store_name`，catalog 未声明这些必填关系。

它们未被顶层 required 自动用例覆盖的失败合同由 L3 `FAILURE_CASES` 表显式锚定。是否调整 catalog schema 或统一 workflow envelope 应作为独立接口变更评审，不属于本轮测试去重。

## Helper 合并审计

逐对比较同名函数后，只合并了逐字等价的 `_form_value`（`data` 版本）、`_form_values`、`_sheet_names`（`read_only=True` 版本）和 `_write_mabang_msku`。以下差异版本保留在原测试文件：

- `fba_store_resolver._form_value` 读取 `params`，错误文案也不同。
- `_sheet_names` 的其余版本分别使用 `data_only=True`、非 read-only workbook，语义不相同。
- `_xlsx_bytes` 的默认列、类型签名和 workbook close 行为不同。
- `_write_csv` 的固定 headers、显式 columns 和写入循环不同。
- `_write_products` 分别使用 openpyxl 与 pandas。
- `_write_input_workbook` 的 sheet 布局、merge rows 以及伴随文件副作用不同。

## 删除用例到 contract runner 的映射

- `test_mabang_stock_sku_download_cli.py` 的 missing/invalid delivery → `FAILURE_CASES["fba stock-sku download"]`。
- `test_mabang_fba_delivery_download_cli.py` 的 missing/invalid/download error → `FAILURE_CASES["fba shipment delivery-csv-download"]`。
- `test_mabang_fba_delivery_tax_summary_cli.py` 的 missing/invalid delivery → `FAILURE_CASES["fba export-tax delivery-summary"]`。
- `test_mabang_msku_detail_download_cli.py` 的 missing/invalid/download error → `FAILURE_CASES["fba msku detail-download"]`。
- `test_mabang_wms_download_cli.py` 的 missing/invalid/download error → `FAILURE_CASES["fba shipment wms-box-download"]`。
- `test_mabang_amazon_restock_inventory_snapshot_cli.py` 的 missing store → `FAILURE_CASES["replenish inventory restock-snapshot-build"]`。
- `test_mabang_store_msku_download_cli.py` 的 missing store/download error → `FAILURE_CASES["replenish msku download"]`。
- `test_mabang_store_msku_replenishment_cli.py` 的 missing store → `FAILURE_CASES["replenish calculate"]`。
- `test_mabang_store_msku_sales_analysis_cli.py` 的 missing store → `FAILURE_CASES["replenish sales analyze"]`。
- `test_mabang_store_msku_actual_inventory_cli.py` 的 missing store → `FAILURE_CASES["replenish inventory actual-export"]`。
- `test_mabang_fba_unlinked_shipments_cli.py` 的 missing store/download error → `FAILURE_CASES["replenish shipments unlinked-download"]`。

每个被处理命令仍至少保留一个成功路径测试；WMS force-refresh、snapshot、拆箱、工作簿和补货算法等业务专属测试未删除。
