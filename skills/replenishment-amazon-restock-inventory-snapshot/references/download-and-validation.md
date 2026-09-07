# 下载与库存校验

截图路径相对于本参考文件目录；调用 send_files 前将 assets 路径解析为实际文件绝对路径。



本 skill 的主路径是解析用户已经下载好的亚马逊补充库存 CSV。用户需要下载指引时，按美国站示例引导：

1. 打开美国站补充库存报告入口：`https://sellercentral.amazon.com/reportcentral/RestockReport/1`
2. 或从 Seller Central 进入：`库存 -> 亚马逊物流库存 -> 报告 -> 补货报告`
3. 在 `亚马逊配送报告 / 补充库存` 页面点击 `请求下载 .csv 文件`
4. 报告生成后，在对应 `.csv` 行点击 `下载`
5. 将下载得到的 CSV 路径传给 snapshot CLI

用户问“怎么点”、“发我截图”或“路径图”时，不要读取、不要解析、不要复述截图内容，将以下三张截图按顺序放入 `paths`，一次调用 `send_files`：

```text
../assets/amazon_restock_inventory_download_step_1_menu.jpg
../assets/amazon_restock_inventory_download_step_2_report_menu.jpg
../assets/amazon_restock_inventory_download_step_3_request_csv.jpg
```

只有用户明确要求解释截图时，才补充简短文字说明；否则只说明已发送截图，并提醒最终应上传包含 `Merchant SKU` 和 `Total Units` 的补充库存 CSV。




CLI 会执行硬校验，任一失败都不会生成 snapshot：

- Amazon CSV 的 `Merchant SKU` 至少 `70%` 能在马帮原生 MSKU 表中找到。
- Amazon `Total Units` 前 10 的 `Merchant SKU` 中，至少 `70%` 能在马帮原生 MSKU 表中找到。
- 每行必须满足 `Inbound = Working + Shipped + Receiving`。
- 每行必须满足 `Total Units = Available + FC transfer + FC Processing + Customer Order + Inbound`。

`Amazon.Found.*` 是真实 MSKU，不做排除，正常参与校验和快照。

