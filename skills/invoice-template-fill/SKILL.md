---
name: invoice-template-fill
description: 填写发票导入模板。用户上传备货 xlsx 并要求填写发票模板、生成发票导入表、把备货单写入 invoice_Template 时使用。
type: amazon_store
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
- 产品图片来自库存 SKU Excel 的 `库存sku图片`，不要改用 MSKU 明细的 `图片链接`。
- `产品材质*` 使用 `中文/英文` 格式，例如 `硅胶/silicone`、`纸质+塑料/paper+plastic`。
- `产品申报单价*` 写入按 `发货量 * 规则价` 计算后的金额，不是单件价格。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Filling Rules

- `产品用途*` 按商品类型填写：表带/表壳为 `装饰/decorate`，手表保护套为 `保护手表用/Used for protecting watches`，包装盒为 `装表带表壳/Watch strap and case`。
- `产品申报单价*` 按商品类型和材质计算：表带+硅胶 `0.35 * 发货量`，表带+尼龙 `0.5 * 发货量`，表带+金属/贱金属 `1 * 发货量`，表壳 `0.35 * 发货量`，包装盒 `0.32 * 发货量`，手表保护套 `0.35 * 发货量`。
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
  "row_count": 12,
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

- `success=true`：告诉用户发票模板已生成，并提供 `output_xlsx`。
- 如果 `notice` 不为空，简要转述缺图或缺少申报价规则的提示。
- `success=false`：只转述 `exception`。
