---
name: amazon-region-switch
description: 切换 Amazon Seller Central 的 marketplace / region，并确认切换结果。
type: amazon_store
---
## When to Use

- 用户要在 Amazon Seller Central 内切换 marketplace / region。
- 用户已经给出明确站点代码，或当前任务就是先确认该站点代码。

## How to Execute

1. 如果用户目标站点不清晰，先直接向用户追问，要求给出标准站点代码，例如 `US`、`UK`、`DE`。
2. 先用 `ziniao_browser(action=get_status)` 确认目标店铺状态：
   - 已选中 → 跳过
   - 在 `running_stores` 中但未选中 → `ziniao_browser(action=attach_store, store_id=...)`
   - 未运行 → `ziniao_browser(action=open_store, store_id=...)`
3. 先进入 Seller Central `/home`，再用 `ziniao_page(action=get_content)` 确认当前站点，避免重复切换。
4. 需要切换时，进入 marketplace / region 切换页，用 `ziniao_page(action=query, mode=page)` 找到目标站点按钮和确认按钮，再逐步点击。
5. 切换完成后，再次用 `ziniao_page(action=get_content)` 或 `ziniao_page(action=query, mode=page)` 确认当前站点。
