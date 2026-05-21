---
name: invoice-template-fill
description: 填写发票导入模板。用户上传备货 xlsx 并要求填写发票模板、生成发票导入表、把备货单写入 invoice_Template 时使用。
type: amazon-fba
---

## When to Use

- 用户上传备货 xlsx，要求填写发票模板。
- 用户说“生成发票导入模板”“填写 invoice_Template”“把这个备货单写入发票模板”等需求。
- 输入文件名应包含 `SP...` 单号和目的国。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.fill_invoice_template`
- 不要手动编辑 `data/invoice_Template/invoice_Template.xlsx`。
- 不要自己拼接马帮 API 请求。
- 不要手写或复用 Cookie/token。
- 只使用本地已有 FBA 发货单 CSV 和本地 WMS 装箱数据；缺文件时不要自动下载，直接转述 CLI 失败原因。
- 发票明细按 `箱号 + 财务合并后的库存SKU` 写入；财务合并规则来自备货单中表头为 `SKU、产品名称、发货量、规则型号、单价` 的财务合并明细表，保留 SKU 以 `汇总表` 为准。
- 财务合并明细表中相同 `SKU + 规则型号 + 单价` 的重复行会自动累加；同一 SKU 出现不同 `规则型号` 或 `单价` 时视为异常。
- 产品图片来自库存 SKU Excel 的 `库存sku图片`，不要改用 MSKU 明细的 `图片链接`。
- `产品材质*` 使用 `中文/英文` 格式，例如 `硅胶/silicone`、`纸质+塑料/paper+plastic`。
- `产品申报单价*` 写入单件规则价，不乘以发货量。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Filling Rules

- `产品用途*` 按商品类型填写：表带/表壳为 `装饰/decorate`，手表保护套为 `保护手表用/Used for protecting watches`，包装盒为 `装表带表壳/Watch strap and case`。
- `产品申报单价*` 按商品类型和材质计算：表带+硅胶 `0.35`，表带+尼龙 `0.5`，表带+皮革 `0.5`，表带+金属/贱金属 `1`，表壳 `0.35`，包装盒 `0.32`，手表保护套 `0.35`。
- `单箱产品申报数量*` 来自装箱数据拆分后，在每个箱内按 `规则型号 + 单价` 归并得到的数量，不再直接使用备货单汇总发货量。
- `货箱编号*`、`单件货箱重量(KG)*`、`货箱长度(CM)*`、`货箱宽度(CM)*`、`货箱高度(CM)*` 来自本地装箱数据。
- 没有匹配到材质、用途或申报价规则时，保留对应字段为空或写入固定提示，并在 CLI `notice` 中提示。

## Required Input

- 必须有一个备货 xlsx 文件。
- 文件名必须包含 `SP...` 单号和目的国。
- 如果用户没有提供 xlsx 文件，先追问，不要启动 CLI。

## How to Execute

固定执行：

```powershell
uv run --frozen python -m services.agent_cli.mabang.fill_invoice_template --input-xlsx <备货单.xlsx>
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "sp_no": "SP260414001",
  "destination_country": "美国",
  "input_xlsx": "...xlsx",
  "output_xlsx": "artifacts/invoice_template/SP260414001_invoice_Template.xlsx",
  "row_count": 18,
  "source_row_count": 12,
  "invoice_row_count": 18,
  "box_count": 3,
  "delivery_csv_path": "artifacts/mabang_fba_delivery/SP260414001_370502.csv",
  "consignment_excel_path": "artifacts/mabang_wms_consignment/SP260414001.xls",
  "stock_sku_xlsx_paths": [
    "artifacts/mabang_stock_sku/SP260414001_invoice_batch001.xlsx"
  ],
  "image_matched_count": 10,
  "image_missing_count": 2,
  "notice": [
    "第5行缺少产品图片: SKU=..."
  ],
  "source": "invoice_template_fill"
}
```

失败时：

```json
{
  "success": false,
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户发票模板已生成，并提供 `output_xlsx`；可简要说明已按装箱数据拆分为 `invoice_row_count` 行。
- 如果 `notice` 不为空，简要转述缺图或缺少申报价规则的提示。
- `success=false`：只转述 `exception`。
