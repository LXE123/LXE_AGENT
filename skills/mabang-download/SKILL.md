---
name: mabang-download
description: 下载马帮 WMS 托运单装箱数据 Excel。用户明确要求装箱数据、托运单 Excel、WMS 下载，或为 Amazon FBA 创建货件准备装箱 Excel 时使用；不要用于 FBA 发货单、发货单 SKU 数据、发货单表格下载。
type: amazon_store
---

## When to Use

- 用户要下载或刷新马帮 WMS 托运单 Excel。
- 用户要先准备 `services/test_file/<ship_no>.xls|xlsx`，再执行 Amazon FBA 创建货件流程。
- 用户明确提到“装箱数据”“托运单 Excel”“WMS 下载”等需求。
- 如果用户说“发货单”“FBA 发货单”“发货单 SKU 数据”“发货单表格”，不要使用本 skill，应使用 `mabang-fba-delivery-download`。

## Hard Rules

- 只执行本 skill 明确列出的固定 CLI。
- 不要直接调用 Python 内部函数。
- 不要猜测本地路径；以 CLI 返回的 `excel_path` 为准。
- 不要因为用户只给了 `SP...` 单号就使用本 skill；必须同时明确是 WMS 装箱/托运单需求。
- 不要用于下载 FBA 发货单 CSV。
- CLI 失败时只转述 `exception` 原文，不要猜测原因。

## WMS 托运单装箱 Excel

### Required Input

- 必须有 `ship_no` 或 `consignment_no`。
- 单号必须是 `SP` 开头的托运单号。
- 如果缺少单号，或用户给的不是 `SP...`，先向用户追问，不要启动 CLI。

### How to Execute

固定使用下面的 CLI：

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_wms_consignment_excel --ship-no <ship_no>
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "ship_no": "SPxxxx",
  "excel_path": "...",
  "source": "wms",
  "box_count": 12,
  "split_required": true,
  "split_excel_paths": [".../SPxxxx-1.xlsx", ".../SPxxxx-2.xlsx", ".../SPxxxx-3.xlsx"]
}
```

失败时：

```json
{ "success": false, "ship_no": "SPxxxx", "exception": "..." }
```

### Result Handling

- `success=true`：告诉用户托运单 Excel 已准备好，并保留 `excel_path`。
- `split_required=true`：同时告诉用户原始文件超过 5 箱，系统已经按每 5 箱拆分。
- 有 `split_excel_paths` 时，后续创建 Amazon FBA 货件应分别使用拆分文件名对应的 `consignment_no`，例如 `SP2000202021-1`、`SP2000202021-2`。
- `split_required=false`：继续使用原始 `ship_no` 作为后续 `consignment_no`。
- `success=false`：只转述 `exception` 原文。
- 成功后，如果用户要继续创建 Amazon FBA 货件，执行 `amazon-fba-shipment-create` 的第一段 `prepare_upload`。
