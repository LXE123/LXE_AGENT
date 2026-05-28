---
name: mabang-msku-detail-download
description: 根据 SP 单号从 FBA 发货单提取 MSKU，并下载马帮 MSKU 明细 Excel。用户要求获取 MSKU 详细数据、MSKU 明细、为发票填写准备 MSKU 数据文件时使用。
type: amazon_fba
---

## When to Use

- 用户要获取某个 `SP...` 的 MSKU 明细数据。
- 用户说“下载 MSKU 详细数据”“获取 MSKU 明细 Excel”“发票填写前先准备 MSKU 数据”等需求。
- 本 skill 只负责准备 MSKU 明细 Excel；后续发票填写由其它 skill/步骤处理。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.download_msku_detail_excel`
- 不要手动读取、编辑或生成 MSKU 明细 Excel。
- 不要自己拼接马帮 API 请求。
- 不要手写或复用 Cookie/token。
- MSKU 来源是 FBA 发货单文件中的 `MSKU` 列；不要改用 WMS 装箱数据。
- CLI 会用发货单文件中的 `店铺 + MSKU` 校验下载后的 MSKU 明细。
- 本地没有发货单文件时，CLI 会调用固定发货单下载流程准备发货单。
- 后续自动化读取只使用 `xlsx_path`；`xlsx_path` 已按发货单店铺过滤。
- 如果马帮返回 `.xls`，CLI 转换成功后会删除原始 `.xls`，不要发送 `excel_path`。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Required Input

- 必须有 `SP...` 单号。
- 如果用户没有提供 `SP...`，先追问，不要启动 CLI。

## How to Execute

固定执行：

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_msku_detail_excel --delivery-no <SP单号>
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "ship_no": "SP260414001",
  "delivery_file_path": "artifacts/mabang_fba_delivery/SP260414001_370502.csv",
  "delivery_file_source": "local",
  "msku_count": 41,
  "id_count": 58,
  "excel_path": "artifacts/mabang_msku_detail/SP260414001_msku_detail.xls",
  "xlsx_path": "artifacts/mabang_msku_detail/SP260414001_msku_detail.xlsx",
  "converted": true,
  "raw_excel_deleted": true,
  "matched_detail_count": 41,
  "shop_mismatch_count": 0,
  "shop_mismatch_sheet": "店铺不一致",
  "source": "mabang_msku_detail"
}
```

失败时：

```json
{
  "success": false,
  "ship_no": "SP260414001",
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户 MSKU 明细 Excel 已下载完成，并提供 `xlsx_path`。
- 如果 `shop_mismatch_count > 0`，告诉用户有店铺不一致的 MSKU 明细，已放在 `店铺不一致` sheet。
- 可以简要说明 `msku_count` 和 `id_count`。
- `success=false`：只转述 `exception`。
