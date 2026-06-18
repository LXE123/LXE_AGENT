---
name: replenishment-amazon-restock-inventory-snapshot
description: 将用户从 Seller Central 手动下载的亚马逊补充库存 CSV 解析为备货可用的亚马逊补充库存 snapshot。用户要求使用亚马逊补充库存、解析补充库存 CSV、校验补充库存文件是否对应店铺、询问亚马逊库存报告怎么下载/哪里下载/下载路径/截图指引，或在备货建议中增加亚马逊补充库存扣减字段时使用；如果用户只给模糊店铺名，先使用 replenishment-store-resolve 获取规范 store_name。
type: amazon_replenish
---

## When to Use

- 用户已经从 Seller Central 下载亚马逊补充库存 CSV，需要转成备货可用 snapshot。
- 用户不知道亚马逊库存 CSV 去哪里下载，需要下载路径或截图指引。
- 用户要用亚马逊补充库存报告里的 `Total Units` 作为亚马逊侧 FBA 总库存字段。
- 用户要检查亚马逊补充库存文件是否传错店铺。

## Hard Rules

- 默认解析命令：`uv run --frozen python -m services.agent_cli.mabang.build_amazon_restock_inventory_snapshot --store-name "<店铺名>" --csv "<亚马逊补充库存CSV>"`
- 本 skill 不登录 Seller Central，不自动下载亚马逊补充库存文件。
- CSV 必须是 Seller Central 补充库存报告，并包含 `Merchant SKU` 和 `Total Units`。
- CLI 会基于本地最新马帮原生 MSKU 数据做校验；如果本地没有店铺 MSKU 文件，先运行 `replenishment-msku-download`。
- 只读取 CLI 输出的最后一行 JSON。
- CLI 失败时只转述最后一行 JSON 里的 `exception` 原文。

## Download Guide

本 skill 的主路径是解析用户已经下载好的亚马逊补充库存 CSV。当前项目还没有补充库存报告的专用截图；如果用户问“怎么点”、“发我截图”或“路径图”，先说明截图只是 Seller Central 报告入口的临时参考，不是补充库存报告的最终专用教程。

用户仍要求看截图时，不要读取、不要解析、不要复述截图内容，直接按顺序调用 `send_file` 发送以下三张临时参考图：

```text
skills/replenishment-amazon-restock-inventory-snapshot/assets/amazon_restock_inventory_download_step_1_menu.jpg
skills/replenishment-amazon-restock-inventory-snapshot/assets/amazon_restock_inventory_download_step_2_report_menu.jpg
skills/replenishment-amazon-restock-inventory-snapshot/assets/amazon_restock_inventory_download_step_3_request_csv.jpg
```

只有用户明确要求解释截图时，才补充简短文字说明；否则只说明已发送临时参考图，并提醒最终应上传包含 `Merchant SKU` 和 `Total Units` 的补充库存 CSV。

## How to Execute

如果店铺名不确定，先解析店铺：

```powershell
uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store --store-name "<店铺名>"
```

解析成功后，生成亚马逊补充库存 snapshot：

```powershell
uv run --frozen python -m services.agent_cli.mabang.build_amazon_restock_inventory_snapshot --store-name "<店铺名>" --csv "<亚马逊补充库存CSV>"
```

如果用户明确提供了马帮原生 MSKU 文件路径，可附加：

```powershell
--msku-xlsx "<马帮原生MSKU文件.xlsx>"
```

## Validation Rules

CLI 会执行硬校验，任一失败都不会生成 snapshot：

- Amazon CSV 的 `Merchant SKU` 至少 `70%` 能在马帮原生 MSKU 表中找到。
- Amazon `Total Units` 前 10 的 `Merchant SKU` 中，至少 `70%` 能在马帮原生 MSKU 表中找到。
- 每行必须满足 `Inbound = Working + Shipped + Receiving`。
- 每行必须满足 `Total Units = Available + FC transfer + FC Processing + Customer Order + Inbound`。

`Amazon.Found.*` 是真实 MSKU，不做排除，正常参与校验和快照。

## Result Handling

成功时：

```json
{
  "success": true,
  "store_name": "Amazon-YRZ-US",
  "snapshot_time": "202606211530",
  "snapshot_date": "20260621",
  "snapshot_xlsx_path": "artifacts/amazon_restock_inventory_snapshots/202606211530-Amazon-YRZ-US_亚马逊补充库存快照.xlsx",
  "amazon_restock_inventory_validation": {
    "country": "US",
    "mabang_site": "美国站",
    "amazon_sku_count": 1774,
    "matched_amazon_sku_count": 1700,
    "amazon_sku_match_ratio": 0.9583,
    "top_inventory_sku_count": 10,
    "top_inventory_matched_count": 10
  },
  "source": "amazon_restock_inventory_snapshot"
}
```

- 告诉用户 snapshot 已生成，并列出 `snapshot_xlsx_path`。
- 简要说明 Amazon SKU 匹配率和 Top 库存 SKU 匹配数。
- 如果用户要把这个 snapshot 用进备货建议，切换到 `replenishment-calculate`，并在计算命令中传 `--amazon-restock-inventory-snapshot "<snapshot_xlsx_path>"`。
