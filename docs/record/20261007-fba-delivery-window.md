# FBA 货件送达时段自动化（方案，待评审）

- 状态：**方案已出，未开工**。本文是新工作流的交接说明，含已核实事实、方案、待拍板项和 worktree 现状。
- 日期：2026-10-07
- 结论先行：**要改的「送达时段」在 Amazon 侧，SP-API 有官方写接口。** 全链路里真正只能靠紫鸟浏览器的，可能只剩「去货代后台查转单号」这一步。所以本任务不是重写 agent，而是给现有 `fba-shipment-*` 家族加一条命令 + 一个可替换的数据源适配器。

## 1. 业务流程与术语纠正

用户原话流程（站点：美国、英国、德国、澳大利亚、加拿大、日本）：

1. 打开紫鸟店铺
2. 点击货件 → 选一个 FBA 货件编号 → 在 FBA 货件跟踪表查看是哪家物流
3. 在物流商后台系统查询对应的转单号
4. 在尾程派送商界面输入对应转单号
5. 根据对应时间去修改送达时间段（UPS：18 位，如 `1ZJ73E760318629223`；FedEx：12 位，如 `889534128747`）

**术语纠正**：这里说的「店铺订单号」实际是 **FBA 货件编号（ShipmentId）**，形如 `FBA19S7JLCB5`；不是 Amazon 买家订单号（`123-1234567-1234567`）。做需求时别再按"订单"理解。

## 2. 已核实的事实

### 2.1 「送达时段」在 Amazon 侧（关键结论）

- 「管理货件」列表有独立的「送达时段」列，值形如 `11月1日 - 2026年11月7日`。
- 「发送至亚马逊（STA）」最后一步「追踪详情」里有 `（编辑时段）` 链接，旁边是「承运人」和追踪编码输入区。
- 货件跟踪页 URL 形态：`https://sellercentral.amazon.com/fba/inbound-shipment/summary/<ShipmentId>/tracking`，页内有 `货件活动 / 承运人更新 / 物品信息 / 问题` 四个 tab。
- 因此：**改时段改的是 Amazon，不是 UPS/FedEx 的预约系统。**

### 2.2 全链路覆盖情况

| 步骤 | 归属系统 | 官方通道 | 核实状态 |
| --- | --- | --- | --- |
| 读货件编号 / 目的地 / 送达时段 | Amazon | `listInboundPlans` + Fulfillment Inbound v2024-03-20 的 GET 操作 | 官方 FAQ 明确说 STA 建的货件也能读；**尚未用真实账号实测** |
| 判断承运人 / 读追踪编码 | Amazon | `listTransportationOptions`（承运人 name/alphaCode + `shippingSolution`）；`getShipment` 的 `trackingDetails` | 见 2.3 的缺口 |
| 货代后台查转单号 | 货代 | 无 | **多家混用，需业务方确认** |
| 查 UPS/FedEx 实际派送时间 | 承运人 | UPS Developer Kit Track / FedEx Track API | 只覆盖北美；6 站点是长尾（英/德/澳/日多为本地派送商） |
| **改送达时段** | Amazon | `confirmDeliveryWindowOptions(inboundPlanId, shipmentId, deliveryWindowOptionId)` | 官方 recipe 已确认存在，返回 `operationId` |

你列的 6 个站点全部在 v2024-03-20 的支持列表内（US/UK/DE/AU/CA/JP 都在）。

### 2.3 三个已知的坑

1. **追踪号 API 有缺口**：`getShipment` 的 `trackingDetails` 只对手工录入的追踪号返回；**Amazon 合作承运人自动生成的追踪号不返回**。v0 的 `getTransportDetails` 曾经有，v2024 没有，上游 issue 以 `not_planned` 关闭。→ 别指望 API 给货代转单号，那个号只在货代系统里。
2. **现有数据质量问题**：截图里的「追踪编码」填的是 `FBA19S7JLCB5U000001`，正是隔壁列「亚马逊物流包装箱标签编号」。就算 API 读到了 `trackingDetails`，读回来的也是这个占位值。**需业务方确认这是常规做法还是异常。**
3. **STA 可读性未实测**：官方 FAQ 说可以，社区一直有争议。落地前必须先花十分钟用真实账号调一次 `listInboundPlans`（见 §3.3 的 P0.5 Gate）。
4. **ShipTrack 可能让流程消失**（待评估，不是现在的任务）：STA 追踪页右下角有 NEW「Ship with ShipTrack」，改用 ShipTrack 承运人后 Amazon 会自动从承运人接收并回填追踪信息。相关社区提问：有没有 API 让 ShipTrack/FIST 承运人更新送达时段——2026-01 提的，至今 open。

### 2.4 仓库已有能力（别重复造）

| 能力 | 位置 |
| --- | --- |
| 送达时段日历操作（Amazon 页内） | `python/lxeskill_cli/services/agent_cli/browser/amazon_common/own_carrier.py:39`（`arrival-edit-delivery-window-link`）、`:1764`（等日历出现）、`:1096`（modal 确认） |
| 读货件摘要（货件名称/编号/追踪编号/收货地址）并落 Excel | 同上 `:313` `_collect_shipment_summaries`、`:405` `_write_shipment_summary_excel` |
| 进「追踪」tab、填追踪编码、保存 | `python/lxeskill_cli/services/agent_cli/browser/amazon_common/shipment_tracking.py:10`（`shipment-tracking-tab`）、`:225` `_fill_tracking_row_input` |
| 多站点切换与 URL 拼装 | `python/lxeskill_cli/services/agent_cli/browser/amazon_common/region_switch.py`、`seller_central_url.py` |
| 命令契约元数据参考 | `catalog.json` 里 `amazon_fba_confirm_own_carrier`：`visibility: business`、`session_mode: lxe_session`、`timeout_ms: 600000`、`artifact_paths[0] = {field: "file_path[].value", role: "deliverable"}` |
| 现有 skill 写法 | `skills/fba-shipment-create/SKILL.md` |

## 3. 方案

### 3.1 数据源适配器（核心设计）

把「数据源」做成可替换边界，而不是把 SP-API 硬写进流程：

```text
FbaShipmentSource（接口）
  list_shipments(site)                         → 货件清单 + 承运人 + 当前送达时段
  get_shipment_detail(shipment_id)             → 追踪编码、箱级信息
  update_delivery_window(shipment_id, window)  → 改时段（写）

实现 A：BrowserShipmentSource  （紫鸟 Selenium，兜底，任何账号都能跑）
实现 B：SpApiShipmentSource    （SP-API，配了凭据就走它）
```

选谁由配置决定：有 SP-API 凭据走 B，否则走 A。与仓库现有分工一致（马帮走官方 API，页面动作才上 Selenium）。

**换 API 的一个实打实收益**：SP-API 版可以做到 `session_mode: none`——不需要紫鸟店铺在跑。

### 3.2 两条命令

沿用现有 `fba shipment <动作>` 风格，不用 `--action`：

| 命令 | 作用 | 说明 |
| --- | --- | --- |
| `lxeskill fba shipment delivery-window list` | 出货件表（Excel/JSON 产物） | 只读 |
| `lxeskill fba shipment delivery-window apply` | 改送达时段 | 写操作，**默认 dry-run，加 `--apply` 才真写**；返回 Amazon 的 `operationId` |

### 3.3 阶段划分

| 阶段 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| P0 | 紫鸟浏览器读：管理货件列表 → 点「追踪」进 `<ShipmentId>/tracking` → 读「承运人更新」tab | 无 | 产物 Excel 与人工核对一致 |
| **P0.5（Gate）** | 真实账号调一次 `listInboundPlans`，确认能列出 `FBA STA (...)` 货件 | 开发者身份 | 能列出才继续 P1，否则 P1 降级 |
| P1 | SP-API 读，替换 P0 读取层，P0 保留兜底 | P0.5 通过 + 凭据 | 同店铺同时刻，API 与 P0 逐字段一致 |
| P2 | SP-API 写送达时段 | P1 | 先 dry-run，再真改 1 个货件，回页面核对 |
| P3（可选） | 货代段 adapter（先做单家） | 业务指定货代 | 转单号能自动取回 |

P0 在前的原因：SP-API 要申请、授权、配凭据、改桌面配置，周期长；P0 立刻能跑，且它的产物就是 P1 的验收基线。

### 3.4 文件级清单

**契约与技能**

- 新增 `skills/fba-shipment-delivery-window/SKILL.md`（`type: amazon_fba`）
- `python/lxeskill_cli/lxeskill/catalog.json` 新增 2 条 entry（浏览器版 `session_mode: lxe_session`；API 版 `session_mode: none`）
- catalog 是双端契约，改完必须两边跑定向测试（见 §7）

**Python**

- 新增 `services/agent_cli/browser/amazon_common/shipment_list.py`（读列表 + 进 tracking 页）
- 新增 `services/agent_cli/browser/amazon_common/delivery_window.py`（**从 `own_carrier.py` 抽取**送达时段日历逻辑，两边共用，禁止复制）
- 新增 `services/agent_cli/browser/amazon_fba/delivery_window_list.py` / `delivery_window_apply.py`（命令入口）
- 扩展 `amazon_common/shipment_tracking.py`（目前只会写追踪编码，加「读」）
- P1 新增 `services/amazon/sp_api/`：`client.py`（LWA 换 token + 调用 + 限流退避）、`inbound.py`（Inbound v2024-03-20 操作）、`credentials.py`（读环境变量）
- 按站点留 selector 变体（US 的 STA 页面结构未必等于 JP/DE），可复用 `own_carrier.py` 已有的 layout 探测模式

**桌面（仅 P1）**

- `apps/desktop/src/main/config-store/{model,setup,validation,secrets}.ts`：加 `integrations.amazon_sp_api` 段与机密，注入 `AMAZON_SP_API_*` 环境变量（照现有 `ZINIAO_*` 做法，`setup.ts` 里已有先例）
- `apps/desktop/src/main/ipc-validation.ts`：新增字段边界校验

**测试与文档**

- `python/lxeskill_cli/tests/amazon/`：P0 用 driver 打桩（照 `test_own_carrier_layouts.py`）；SP-API 用固定响应 fixture
- `docs/harness/skill/current_skill_catalog.md` 加一行
- P1 落地后本文件升级为正式决策记录

## 4. 待拍板（评审时按编号给意见）

| # | 决策 | 建议 |
| --- | --- | --- |
| 1 | 数据源优先级 | SP-API 优先 + 浏览器兜底，分阶段落地 |
| 2 | 命令粒度 | 两条独立命令（写操作单独一条，权限/确认语义更清楚） |
| 3 | 多店铺 refresh token 怎么给 Python 用 | 桌面把「店铺→token」映射写成 JSON 注入环境变量，Python 按 `store_id` 取；不要一次只支持一个店铺 |
| 4 | 写操作确认语义 | 默认 dry-run，`--apply` 才真写 |
| 5 | 是否现在就动 SP-API | 先只做 P0 + P0.5，Gate 过了再写 P1，避免白写 |

## 5. 待业务方确认

1. 「追踪编码」现在填的是箱子标签编号（`FBA19S7JLCB5U000001`），这是常规占位做法吗？（页面自己说准确追踪信息能提高约 30% 接收速度）
2. 货代是哪几家、有没有 API 或导出能力？（回答"多家混用/不确定"过，需要具体名单才能排 P3）

## 6. 本 worktree 现状与阻塞（新工作流必读）

- slot：`.worktrees/pool-1`，分支 `codex/fba-delivery-window`，认领标记 `.worktrees/pool-1.claim`。
- **依赖未同步**：该 slot 内 `.venv` 与 `node_modules` 都不存在，`wt-claim` 的 `sync_deps` 中途失败。
- 失败原因（已实测，不是脚本 bug）：`bun install` 要写 `~/.bun/install/cache`、`uv sync` 要写 `~/.cache/uv`，两者在会话沙箱的可写范围之外，报 `bun is unable to write files to tempdir: EPERM`。`$TMPDIR`、`/tmp`、工作区内路径实测都可写，改 TMPDIR 不解决。
- 出路（任选）：
  1. 在**沙箱外**的终端跑一次 `scripts/wt-claim fba-delivery-window`（slug 已占，脚本走 resume 分支，只补依赖同步，不重建 worktree）
  2. 授权执行者一次放宽沙箱权限后重跑同一条命令
  3. 把 `~/.bun` 与 `~/.cache/uv` 加进沙箱可写根（长期解法，需改环境配置）
- 归还：`scripts/wt-claim release fba-delivery-window`（当前干净可释放；分支未合并会被保留）
- 本任务**未修改任何主代码区文件**；主工作区 `main` 仍在 `5f785341`。

## 7. 红线与纪律（只引用，不复制）

- 紫鸟店铺的页面级操作**只能**走官方配对 Selenium：`docs/harness/skill/reference/ziniao-webdriver-doc-1.0.0/reference/automation-framework-policy.md`
- 不新增 Python 自有表：货件↔转单号这类业务映射落产物文件，不进 DB
- SP-API 凭据属机密，按红线放桌面 `config-store` 的 integrations/secrets，不进 Python DB
- 失败时原样带出 Amazon 的真实错误，不包装（错误真实性）
- 提交、测试、worktree 流程一律照 `AGENTS.md`，本文不复制

## 8. 证据索引

**官方文档**

- Fulfillment Inbound FAQ（STA 货件可读 / `listTransportationOptions` / 送达时段是新特性 / 支持站点列表）：https://developer-docs.amazon/sp-api/docs/fulfillment-inbound-faq
- `confirmDeliveryWindowOptions` recipe：https://developer-docs.amazon/sp-api/recipes/confirm-delivery-window-options-1
- 非合作承运人建货件：https://developer-docs.amazon/sp-api/docs/create-non-partnered-carrier-shipment

**上游缺口**

- `trackingDetails` 缺失（已 not_planned）：https://github.com/amzn/selling-partner-api-models/issues/4606
- 让 ShipTrack/FIST 承运人更新送达时段的 API（open）：https://github.com/amzn/selling-partner-api-models/issues/5106

**仓库内**

- `python/lxeskill_cli/services/agent_cli/browser/amazon_common/own_carrier.py`
- `python/lxeskill_cli/services/agent_cli/browser/amazon_common/shipment_tracking.py`
- `python/lxeskill_cli/services/agent_cli/browser/amazon_common/region_switch.py`
- `python/lxeskill_cli/lxeskill/catalog.json`
- `skills/fba-shipment-create/SKILL.md`
- `docs/harness/skill/reference/ziniao-webdriver-doc-1.0.0/reference/automation-framework-policy.md`
