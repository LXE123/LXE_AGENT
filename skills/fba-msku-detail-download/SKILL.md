---
name: fba-msku-detail-download
description: 根据 SP 单号从 FBA 发货单提取 MSKU，并下载马帮 MSKU 明细 Excel。用户要求获取 MSKU 详细数据、MSKU 明细、为发票填写准备 MSKU 数据文件时使用。
type: amazon_fba
---

# FBA MSKU Detail Download

## Hard Rules

- 只使用固定 CLI。
- 不要手动读取、编辑或生成 MSKU 明细 Excel。
- 不要自己拼接马帮 API 请求，不要手写或复用 Cookie/token。
- MSKU 来源固定为 FBA 发货单文件中的 `MSKU` 列；不要改用 WMS 装箱数据。
- CLI 会用发货单文件中的 `店铺 + MSKU` 校验下载后的 MSKU 明细。
- 本地没有发货单文件时，CLI 会调用固定发货单下载流程准备发货单。
- 后续自动化只使用 `xlsx_path`；原始 `.xls` 转换成功后由 CLI 清理。

## Required Input

- `delivery_no`: `SP` 开头的发货单号。
- 缺少 `SP...` 时先追问，不要启动 CLI。

## Command

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_msku_detail_excel --delivery-no <SP单号>
```

只读取 CLI 输出的最后一行 JSON。

## Result Handling

- `success=true`：告诉用户 MSKU 明细 Excel 已下载完成，并提供 `xlsx_path`。
- `shop_mismatch_count > 0`：说明存在店铺不一致的 MSKU 明细，已放在 `店铺不一致` sheet。
- `success=false`：只转述 `exception`。
