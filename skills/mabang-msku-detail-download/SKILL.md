---
name: mabang-msku-detail-download
description: 根据 SP 单号从本地 WMS 装箱数据提取 MSKU，并下载马帮 MSKU 明细 Excel。用户要求获取 MSKU 详细数据、MSKU 明细、为发票填写准备 MSKU 数据文件时使用。
type: amazon_store
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
- 不要自动下载 WMS 装箱数据；CLI 只会查找本地装箱数据。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文，不要猜测原因。

## Required Input

- 必须有 `SP...` 单号。
- 如果用户没有提供 `SP...`，先追问，不要启动 CLI。
- 本地必须已经存在对应装箱数据 Excel，通常位于 `services/test_file/<SP单号>.xls` 或 `services/test_file/<SP单号>.xlsx`。

## How to Execute

固定执行：

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_msku_detail_excel --ship-no <SP单号>
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "ship_no": "SP260414001",
  "consignment_excel_path": "...SP260414001.xls",
  "msku_count": 41,
  "id_count": 58,
  "excel_path": "artifacts/mabang_msku_detail/SP260414001_msku_detail.xls",
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

- `success=true`：告诉用户 MSKU 明细 Excel 已下载完成，并提供 `excel_path`。
- 可以简要说明 `msku_count` 和 `id_count`。
- `success=false`：只转述 `exception`。
