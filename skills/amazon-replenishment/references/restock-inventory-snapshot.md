# 亚马逊补充库存对照快照与下载指引

仅在用户明确要求 Amazon 侧补充库存对照或询问补充库存报告下载方式时使用；输入为用户从 Seller Central 手动下载的 CSV。不自动登录或下载 Seller Central 数据，也不替换主流程马帮库存口径。

## 生成对照快照命令

```text
lxeskill replenish inventory restock-snapshot-build --store-name "<规范店铺名>" --csv "<CSV路径>" [--msku-xlsx "<源表路径>"]
```

未显式指定 `--msku-xlsx` 时自动匹配该店铺本地最新 MSKU 源表；模糊店铺名先按 [store-resolve.md](store-resolve.md) 解析规范店铺名。

## 硬校验与结果处理

CLI 会执行以下硬校验，任一失败均不生成 snapshot（失败时保留实际错误，不自行转换字段）：

- CSV 必须包含 `Merchant SKU`、`Total Units` 等必填分项列。
- Amazon CSV 的 `Merchant SKU` 至少 `70%` 能在马帮原生 MSKU 表中找到。
- Amazon `Total Units` 前 10 的 `Merchant SKU` 中，至少 `70%` 能在马帮原生 MSKU 表中找到。
- 每行必须满足 `Inbound = Working + Shipped + Receiving`。
- 每行必须满足 `Total Units = Available + FC transfer + FC Processing + Customer Order + Inbound`。
- `Amazon.Found.*` 是真实 MSKU，不做排除，正常参与校验和快照。

成功后保留 `data.snapshot_xlsx_path` 和核验摘要：

- 单步任务直接调用 `send_files(paths=<terminal.files>)` 交付快照文件。
- 用于 V1 备货计算时，将该路径传入 `lxeskill replenish calculate --version v1 ... --amazon-restock-inventory-snapshot "<路径>"` 进行同店与日期校验并附带核验摘要（不改变主备货建议量或工作表列结构）。

## Seller Central 下载指引与截图

用户需要下载指引时，以目标店铺对应站点的 Seller Central 页面为准：

1. 进入目标店铺对应站点的补充库存报告页面（美国站入口示例：`https://sellercentral.amazon.com/reportcentral/RestockReport/1`）。
2. 或从 Seller Central 进入：`库存 -> 亚马逊物流库存 -> 报告 -> 补货报告`。
3. 在 `亚马逊配送报告 / 补充库存` 页面点击 `请求下载 .csv 文件`。
4. 报告生成后，在对应 `.csv` 行点击 `下载`。
5. 将下载得到的 CSV 路径传给 snapshot CLI。

用户问“怎么点”、“发我截图”或“路径图”时，不要读取、不要解析、不要复述截图内容，将以下三张截图（相对于本参考文件目录，调用 `send_files` 前解析为实际绝对路径）按顺序放入 `paths`，一次调用 `send_files`：

```text
../assets/amazon_restock_inventory_download_step_1_menu.jpg
../assets/amazon_restock_inventory_download_step_2_report_menu.jpg
../assets/amazon_restock_inventory_download_step_3_request_csv.jpg
```

只有用户明确要求解释截图时，才补充简短文字说明；否则只说明已发送截图，并提醒最终应上传包含 `Merchant SKU` 和 `Total Units` 的补充库存 CSV。
