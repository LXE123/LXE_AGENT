---
name: replenishment-amazon-inventory-snapshot
description: 将用户从 Amazon 后台手动下载的库存 CSV 解析为备货可用的 Amazon 后台库存 snapshot。用户要求使用亚马逊后台 FBA 库存、解析 Amazon 库存 CSV、校验后台库存文件是否对应店铺/站点、或在备货建议中增加 Amazon 后台库存对比字段时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
---

## When to Use

- 用户已经从 Amazon 后台下载库存 CSV，需要转成备货可用 snapshot。
- 用户要用 Amazon 后台的 `Inventory Supply at FBA` 作为对比库存字段。
- 用户要检查 Amazon 后台库存文件是否传错店铺或站点。

## Hard Rules

- 只使用固定 CLI：`uv run --frozen python -m services.agent_cli.mabang.build_amazon_inventory_snapshot --store-name "<店铺名>" --csv "<Amazon后台库存CSV>"`
- 本 skill 不登录 Amazon，不自动下载 Amazon 后台文件。
- CLI 会基于本地最新马帮原生 MSKU 数据做校验；如果本地没有店铺 MSKU 文件，先运行 `replenishment-msku-download`。
- 只读取 CLI 输出的最后一行 JSON。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文。

## How to Execute

如果店铺名不确定，先解析店铺：

```powershell
uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store --store-name "<店铺名>"
```

解析成功后，生成 Amazon 后台库存 snapshot：

```powershell
uv run --frozen python -m services.agent_cli.mabang.build_amazon_inventory_snapshot --store-name "<店铺名>" --csv "<Amazon后台库存CSV>"
```

如果用户明确提供了马帮原生 MSKU 文件路径，可附加：

```powershell
--msku-xlsx "<马帮原生MSKU文件.xlsx>"
```

## Validation Rules

CLI 会执行三条硬校验，任一失败都不会生成 snapshot：

- Amazon CSV 的 `marketplace` 必须和店铺后缀、马帮 `站点` 一致，例如 `Amazon-YRZ-US`、`美国站`、`US`。
- Amazon CSV 的 `sku` 至少 `70%` 能在马帮原生 MSKU 表中找到。
- Amazon `Inventory Supply at FBA` 前 10 的 sku 中，至少 `70%` 能在马帮原生 MSKU 表中找到。

## Result Handling

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-YRZ-US",
  "snapshot_time": "202606161530",
  "snapshot_date": "20260616",
  "snapshot_xlsx_path": "artifacts/amazon_fba_inventory_snapshots/202606161530-Amazon-YRZ-US_amazon_inventory_snapshot.xlsx",
  "amazon_inventory_validation": {
    "marketplace": "US",
    "mabang_site": "美国站",
    "amazon_sku_count": 996,
    "matched_amazon_sku_count": 968,
    "amazon_sku_match_ratio": 0.9719,
    "top_inventory_sku_count": 10,
    "top_inventory_matched_count": 10
  },
  "source": "amazon_fba_inventory_snapshot"
}
```

- 告诉用户 snapshot 已生成，并列出 `snapshot_xlsx_path`。
- 简要说明 `marketplace`、`mabang_site`、Amazon SKU 匹配率和 Top 库存 SKU 匹配数。
- 如果用户要把这个 snapshot 用进备货建议，切换到 `replenishment-calculate`，并在计算命令中传 `--amazon-inventory-snapshot "<snapshot_xlsx_path>"`。
