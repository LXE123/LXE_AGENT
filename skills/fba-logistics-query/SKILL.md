---
name: fba-logistics-query
description: 按完整 FBA 标识在威飒物流后台查询运单、目的仓、尾程承运人和转单号。用于 FBA 物流转单查询；当前仅支持威飒，不提供尾程 ETA 或 Amazon 改期。
type: ziniao_browser
commands:
  - lxeskill logistics wesa query
---

# 威飒单票查询

通过 `exec` 独立调用 canonical CLI。在 LXE_Agent 真实会话中，复用已运行紫鸟店铺和威飒登录态。按 `ziniao-browser` 技能先 `get_status`，核对指定店铺运行，再使用 `--strict-attach --target-host wsaexp.nextsls.com` 快照核对唯一威飒标签页及当前公司账户。`account_name` 使用本次快照实际显示的完整公司名，不能照抄历史账户。

```text
lxeskill logistics wesa query --store-id <store_id> --account-name '<公司账户全名>' --fba <完整FBA> --expected-warehouse <目的仓>
```

命令固定通过官方配对 Selenium，在 `http://wsaexp.nextsls.com` 原页面上下文 POST `/rest/tms/wos/shipment/lists`。内置严格附着，不接受 URL、脚本、密码或 Cookie 参数。默认使用已核实的“全部”完整请求；`--query-mode delivered` 则使用独立抓取的“已签收”请求。

读取 terminal 顶层 `ok` 和 `data`：

- `request_succeeded` 表示 HTTP、业务状态、列表形状和分页检查通过；`found` 表示本页存在完整 FBA 精确匹配，不能混为一谈。
- `matches` 保留全部匹配行、原文、承运人和多个转单号。`missing_fields`、`warnings` 和 `warehouse_matches` 必须报告；不得用第一个结果代替整票，也不能根据号码格式推断承运人。
- 默认只读第 1 页；`complete=false` 时说明只取得部分页面，零匹配只能说本页未找到。用户明确指定后才通过 `--page N` 读取其他页，不自动扫描。
- `returned_active_tab` 与 `all_tab_confirmed` 只证明响应页签读数；跨状态覆盖仍需已知在途样本验证。
- `account_visible=true` 只表示指定公司全名存在于当前可见文本，不能替代上一步对当前公司账户的人工/页面核对，也不证明长期账户归属。
- `queried_at` 为本次 UTC 查询时间。列表不包含已经核实的 ETA/实际签收时间，不用下单时间或页签代替。

失败时保留并转述脱敏后的实际 `data.error` 和 HTTP/业务诊断。登录失效、验证或结构异常时停止，交由用户恢复；不执行马帮 `auth refresh`，不自动重试、重启或切换账户。当前没有物流商账号密码配置或自动登录能力。

查询不授权修改订单、原表或 Amazon；后续改期沿用专用 Amazon 技能的建议、批准和回读流程。
