---
name: replenishment-msku-download
description: 按已解析的马帮 Amazon FBA 店铺 ID 下载该店铺 MSKU 数据 Excel。用户要求获取某个店铺、欧洲区整组或欧洲子站点的 MSKU 数据、店铺 MSKU 表、补货用 MSKU 数据时使用；如果用户只给店铺名，先使用 replenishment-store-resolve 解析 store_name、store_id 和 id_type。
type: amazon_replenish
---

## When to Use

- 用户要下载某个马帮 Amazon 店铺的 MSKU 数据 Excel。
- 用户已提供 `store_name`、`store_id` 和 `id_type`，需要按店铺导出 MSKU 数据。
- 用户只提供店铺名时，先用 `replenishment-store-resolve` 获取 `store_id`、`id_type`、`store_name`。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.download_store_msku_excel`
- 不要手动拼接马帮请求。
- 不要手写、复用或转述样例 Cookie/token。
- 不要猜测店铺 ID；如果缺少 `store_name`、`store_id` 或 `id_type`，先运行 `replenishment-store-resolve`。
- `id_type` 本身就是马帮请求字段名，值只允许是 `fbaWarehouseIds[]` 或 `shopId`。
- 不要把 `shopId` 当作 `fbaWarehouseIds[]` 使用，也不要反过来使用。
- 后续流程只使用 `xlsx_path`；CLI 已把 `.xls` 转成 `.xlsx` 并删除原始 `.xls`。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文。

## Required Input

- 必须有 `store_name`、`store_id` 和 `id_type`。
- `store_name` 用于输出展示和文件命名，不允许省略。

## How to Execute

如果用户只给店铺名，先解析店铺：

```powershell
uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store --store-name "<店铺名>"
```

解析成功后，使用返回的 `store_id`、`id_type`、`store_name` 下载店铺 MSKU 数据：

```powershell
uv run --frozen python -m services.agent_cli.mabang.download_store_msku_excel --store-id "<ID>" --id-type "<fbaWarehouseIds[]|shopId>" --store-name "<店铺名>"
```

只读取 CLI 输出的最后一行 JSON。

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-Lerxiuer-FR",
  "store_id": "697456821",
  "id_type": "shopId",
  "id_count": 123,
  "xlsx_path": "artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
  "converted": true,
  "raw_excel_deleted": true,
  "source": "mabang_store_msku_download"
}
```

失败时：

```json
{
  "success": false,
  "store_name": "Amazon-Lerxiuer-FR",
  "store_id": "697456821",
  "id_type": "shopId",
  "exception": "..."
}
```

## Result Handling

- `success=true`：告诉用户店铺 MSKU 数据已下载完成，并提供 `xlsx_path`。
- 可以简要说明 `store_name`、`store_id`、`id_type` 和 `id_count`。
- `converted=true` 表示马帮返回了 `.xls`，CLI 已转换成 `.xlsx`。
- `success=false`：只转述 `exception`。
