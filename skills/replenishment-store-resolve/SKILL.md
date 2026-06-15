---
name: replenishment-store-resolve
description: 解析马帮 Amazon FBA 店铺名到可查询 ID，支持顶层 fbaWarehouseIds 区域/整组查询和欧洲区子站点 shopId 查询。用户要求查询马帮店铺 ID、确认店铺名、按店铺下载 MSKU 数据前需要解析店铺名，或店铺名不完整需要候选确认时使用（这里没有紫鸟店铺 ID）。
type: amazon_replenish
---

## When to Use

- 用户要获取某个马帮 Amazon 店铺的查询 ID。
- 用户说“xx 店铺的 MSKU 数据”，但后续流程需要先把店铺名解析成可查询 ID。
- 用户只给了部分店铺名，需要从马帮当前店铺列表中确认唯一店铺。
- 用户要查询欧洲区整组店铺，或欧洲区下面某个单站点店铺。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store`
- 不要手动拼接马帮店铺列表请求。
- 不要手写、复用或转述样例 Cookie/token。
- 不要猜测店铺 ID；必须以 CLI 最后一行 JSON 的 `store_id`、`id_type` 为准。
- `id_type` 本身就是后续马帮请求字段名，值只可能是 `fbaWarehouseIds[]` 或 `shopId`。
- 不要把 `shopId` 当作 `fbaWarehouseIds[]` 使用；后续请求应把 `store_id` 填到 `id_type` 指定的字段中。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文。

## How to Execute

列出全部店铺：

```powershell
uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store
```

解析指定店铺：

```powershell
uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store --store-name "<店铺名>"
```

只读取 CLI 输出的最后一行 JSON。

成功列出店铺时：

```json
{
  "success": true,
  "store_count": 149,
  "fba_warehouse_count": 80,
  "shop_count": 69,
  "xlsx_path": "artifacts/mabang_fba_store_resolver/fba_stores_20260521_153000.xlsx",
  "source": "mabang_fba_store_resolver"
}
```

成功解析店铺时：

```json
{
  "success": true,
  "query": "xxx",
  "match_status": "exact",
  "store_name": "xxx店铺",
  "store_id": "123",
  "id_type": "fbaWarehouseIds[]",
  "parent_store_name": "",
  "source": "mabang_fba_store_resolver"
}
```

失败时可能包含候选：

```json
{
  "success": false,
  "query": "xxx",
  "exception": "店铺名不唯一: query=xxx, count=2",
  "candidates": [
    {
      "store_name": "xxx店铺A",
      "store_id": "123",
      "id_type": "fbaWarehouseIds[]",
      "parent_store_name": ""
    },
    {
      "store_name": "xxx店铺B",
      "store_id": "456",
      "id_type": "shopId",
      "parent_store_name": "Amazon-区"
    }
  ]
}
```

候选超过 10 个时：

```json
{
  "success": false,
  "query": "Amazon",
  "exception": "店铺名不唯一: query=Amazon, count=149",
  "candidate_count": 149,
  "candidates_xlsx_path": "artifacts/mabang_fba_store_resolver/fba_store_candidates_Amazon_20260521_153000.xlsx"
}
```

## Result Handling

- `success=true` 且有 `store_id`：告诉用户已解析到店铺 ID，并保留 `store_id`、`id_type` 给后续按店铺下载 MSKU 数据流程。
- `id_type=fbaWarehouseIds[]`：这是顶层区域/整组查询 ID，后续把 `store_id` 填入 `fbaWarehouseIds[]`。
- `id_type=shopId`：这是子站点查询 ID，后续把 `store_id` 填入 `shopId`。
- `success=true` 且返回 `xlsx_path`：告诉用户店铺列表已导出为 xlsx，并说明 `store_count`、`fba_warehouse_count`、`shop_count`。
- `success=false` 且有 `candidates`：列出候选店铺名和 ID，让用户确认完整店铺名。
- `success=false` 且有 `candidates_xlsx_path`：告诉用户候选过多，候选店铺已导出为 xlsx，让用户确认完整店铺名。
- `success=false` 且无候选：只转述 `exception`。
