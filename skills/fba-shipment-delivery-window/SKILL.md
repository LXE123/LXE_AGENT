---
name: fba-shipment-delivery-window
description: 读取 Amazon FBA 货件送达时段，发现同一 Send to Amazon 工作流程中的目的地子货件，或在人工核对 dry-run 后修改指定货件的送达时段。用户提到 FBA 送达时间、配送时间、送达时段、改期、delivery window，或要求查看同一工作流程的子货件时使用。
type: amazon_fba
commands:
  - lxeskill fba shipment delivery-window-list
  - lxeskill fba shipment delivery-window
---

# FBA 货件送达时段

## 硬性规则

- 必须通过 `exec` 独立调用 frontmatter 声明的 canonical `lxeskill` 命令；禁止直接执行 Python 模块或临时浏览器脚本。
- Amazon 页面读取与交互只能走项目的官方配对 Selenium 链路。禁止使用 Playwright、Puppeteer、系统 ChromeDriver 或裸 CDP。
- 先检查 terminal 顶层 `ok`。失败时停止，原样转述 `error.message` 和 `data.exception`；禁止用猜测替代实际错误。
- 执行前按独立 `ziniao-browser` skill 获取真实 `store_id`、复用已运行店铺，并执行一次 `browser_snapshot`。快照必须显示目标站点的 Amazon「管理货件」页面；附着失败时停止。
- `page_url` 必须来自用户提供或本次真实快照中的 Amazon 货件列表绝对 URL。禁止根据店铺名猜站点或复用别的店铺 URL。
- `shipment_ids` 只接受完整 FBA 货件号。禁止把买家订单号、工作流程 ID 或页面序号当作货件号。
- 只有列表页 `orderStatus` 精确为“已发货”的货件可以进入改期。`unitStatus`（例如 `0/172`）只作诊断，不得作为放行依据。
- `apply=true` 是真实 Amazon 写操作。必须先用完全相同的店铺、页面 URL、货件号和目标日期完成 `apply=false` dry-run，向用户回显核对项，并得到一次明确批准。
- 未得到批准时禁止传 `--apply`；不得把“页面可编辑”、用户最初提出改期或 discovery 结果当成最终写入批准。
- 批准后只执行一次同参数 `apply=true`。失败时不自动重试、不换货件、不补点确认按钮。
- 成功只认该货件 `status="applied"` 且 `applied_window` 精确等于目标周；“点击成功”或命令退出码为 0 都不能替代页面回读。

## 输入准备

改期前锁定以下内容：

- 目标店铺名称和真实 `store_id`。
- Amazon 货件列表页绝对 `page_url`。
- 一个或多个完整 `shipment_ids`；自然语言里的“第几个”必须先转换成完整 FBA 号并回显。
- 用户给出的 `target_date`。优先标准化为 `YYYY-MM-DD`；不得沿用历史测试日期或自行猜年份。

目标日期会换算为所在日历周（周日到周六）。模型不得自行计算后直接写入；以 CLI 返回的 `target_window` 为准。

## 只读列表

用户要求查看当前页货件送达时段时执行：

```text
lxeskill fba shipment delivery-window-list --store-id <store_id> --page-url <page_url> --timeout-sec 60
```

只查指定货件时，每个编号使用一个 `--shipment-ids`：

```text
lxeskill fba shipment delivery-window-list --store-id <store_id> --page-url <page_url> --shipment-ids <FBA_ID> --timeout-sec 60
```

命令导航后会等待 Amazon SPA 的货件行出现，默认最多 60 秒；结果读取 `terminal.data.data.rows`。命令只处理当前页；未找到、重复或无法可信解析时停止，不翻页、不猜测。本 skill 的两个命令都使用紫鸟 Amazon 会话，不使用马帮账号；失败时若 `auth_refresh_required=false`，禁止执行 `lxeskill auth refresh`。

## 发现同一工作流程的子货件

当用户要求查看一个 STA 工作流程里的全部目的地子货件时，以一个完整 FBA 号作为种子：

```text
lxeskill fba shipment delivery-window --action discover --store-id <store_id> --page-url <page_url> --shipment-ids <SEED_FBA_ID>
```

`discover` 是只读操作，不传 `target_date`，也禁止传 `--apply`。从 `terminal.data.data.shipments` 展示完整 FBA 号、列表状态、当前时段、截止时间及 `editable/locked/ineligible/unavailable/unknown`。只有 `editable=true` 且列表状态为“已发货”才可作为后续候选；选择后仍须完成下方 dry-run 和人工批准。

## 改期流程

### 1. 参数自检

```text
lxeskill fba shipment delivery-window --store-id <store_id> --page-url <page_url> --shipment-ids <FBA_ID> --target-date <YYYY-MM-DD> --plan-only
```

确认 `terminal.data.data.plan` 中店铺、货件号、目标日期和 `target_window` 与用户意图一致。`plan_only` 不接触浏览器。

### 2. Dry-run

省略 `--apply`：

```text
lxeskill fba shipment delivery-window --store-id <store_id> --page-url <page_url> --shipment-ids <FBA_ID> --target-date <YYYY-MM-DD>
```

只有同时满足以下条件才向用户请求最终批准：

- terminal 顶层 `ok=true`，内部 `success=true`、`finished=true`。
- 目标货件 `status="dry_run_ready"` 或 `status="already_target"`。
- `order_status="已发货"`。
- 完整 FBA 号、`current_window`、`target_window`、`grace.deadline` 均已返回并与用户输入一致。
- `dry_run_ready` 时编辑弹窗已安全取消；没有点击日历或确认按钮。

若为 `already_target`，直接告诉用户无需修改，不请求写入批准。

### 3. 人工批准

请求批准时必须在同一条消息中回显：店铺、每个完整 FBA 号、当前时段、目标日期、目标周和可编辑截止。只问一次是否批准这组明确写入。

### 4. 单次写入

用户明确批准后，在原 dry-run 命令末尾加入 `--apply`，其它参数逐字保持不变：

```text
lxeskill fba shipment delivery-window --store-id <store_id> --page-url <page_url> --shipment-ids <FBA_ID> --target-date <YYYY-MM-DD> --apply
```

成功后回报 `status`、原时段、目标时段和页面回读的 `applied_window`。诊断 JSON 不属于默认交付附件，不主动调用 `send_files`；用户要求审计证据时再说明 terminal 返回的诊断路径。

## 失败处理

- E1–E9 任一失败：停止并原样回传 `failure_code`、`failure_detail`、实际页面读数和 `exception`。
- 多票请求中某票失败后，后续 `not_attempted` 不得另起命令补跑，除非用户重新明确要求。
- 登录态、附着、店铺忙碌或页面结构异常：停止；不要自动重启店铺或改用其它浏览器自动化方案。
- 写入后 `applied_window` 与目标周不一致属于 E8 高风险失败，必须明确说“未验证成功”，不得用乐观措辞。
