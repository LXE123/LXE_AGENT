# FBA 货件送达时段「改期」方案（浏览器路径，待开工）

- 状态：**方案已定稿，未开工**。本文是 `docs/record/20261007-fba-delivery-window.md` 的落地版，范围已按 2026-10-09 评审收窄。
- 日期：2026-10-09
- 结论先行：**要改的确实是 Amazon 侧的送达时段**，但**不需要 SP-API**（写路径也不止 SP-API 一条）。因为业务直接给目标日期，整条「去货代后台查转单号 → 到尾程派送商查实际时间」的链路被砍掉。真正要做的是：**读 Amazon 页面确认货件还没接收完 → 在「追踪详情」的弹窗日历上选目标日 → 确认**，全程走官方配对 Selenium。

## 1. 与 2026-10-07 方案的差异

| 20261007 方案 | 本文 | 原因 |
| --- | --- | --- |
| §3.1 可替换数据源适配器 `FbaShipmentSource`（A 浏览器 / B SP-API） | **只做浏览器路径，不引入适配器层** | 业务直接给日期，读+写都能在页面里完成；SP-API 要开发者身份 + 凭据 + 桌面配置，周期最长 |
| §3.2 两条命令 `list` / `apply` | 保留（`list` 已落地） | — |
| §3.3 阶段表 P0 / P0.5 / P1 / P2 / P3 | **取消阶段表** | P3 货代段被「人直接给日期」取代；P1/P2 的 SP-API 不做了 |
| §2.3 追踪编码 API 缺口是核心障碍 | **不再是障碍** | 不需要转单号 |
| §2.1 用 `own_carrier.py:39` 的 `arrival-edit-delivery-window-link` | **该常量与真实页面不符，禁止使用** | 见 §6.4 |
| §3.4 从 `own_carrier.py` 抽取日历逻辑到 `amazon_common/delivery_window.py` | **改为复用**，不搬动既有文件 | 降低对已上线代码的改动面 |
| §6 worktree 依赖未同步 | **已失效** | `.venv` 与 `node_modules` 均已可用 |

## 2. 已核实的事实

### 2.1 送达时段运行规则（Amazon 官方帮助，2026-10-09 由业务方提供全文）

- 「送达时段」= 预计货件到达亚马逊运营中心的**一周时间**；**要求为整个日历周：从周日开始，到周六结束**。
- 国内与跨境货件均为**一个日历周（7 天）**；**自 2025-08-18 起**对使用非合作承运人的货件在 Send to Amazon 中显示。
- 在计划送达时段内到达 → 优先处理；超出 → 可能面临预约和接收延迟等后果。
- 非合作承运人（小包裹 / 汽运零担）**必须**提供送达时段；合作承运人 / AGL 货件则提供发货日期或货物准备就绪日期。
- 设置与更新入口：创建期间在 **STA 第 2 步**；创建之后在 **STA「追踪详情」步骤**（小包裹快递与汽运零担快递）。
- 「默认情况下，您的库存可能被运往多个运营中心。**更新每个货件的详情卡中每个货件的送达时段**。」
- **可编辑截止**：「可以随时【更新】送达时段，直到以下两个日期中的任意一个先到来：**① 当前送达时段的【时段】开始日期；② 货件的实际送达日期**。」例：时段 4月1日–4月7日 → 可在 3月31日之前编辑；若货件在 3月25日提前送达，则无法更改。
- 通知渠道：电子邮件 +「货件一览」页面的「问题」选项卡 + **入库绩效控制面板**。（业务方口中的「绩效标准」即入库绩效控制面板。）
- 豁免条款：「如果您的承运人已在您提供的送达时段内请求预约，但由于亚马逊的安排而导致在时段之外送达，**我们不会通知您错过送达时段的问题**。」
- 追踪编码的作用：「我们会使用**追踪编码确认实际送达**，并使您的在途库存即使缺货也处于可购买状态。」
- 第 2 步会「**根据所选送达时段向您显示入库选项列表**」，某些时段带【折扣送达时段】标记。
- **另一条写路径**：ShipTrack 认证承运商有 API 可直接获取和更改卖家的预计送达时段（卖家侧需勾选 ShipTrack 认证承运商并授权「授权承运商修改送达时段」，默认开启）。页面上对应 `[data-testid="FIST_ShipTrack_Manage_Delivery_Window_Note"]`（「如果您选择并使用 FIST 承运人，送达时段将自动更新」）。

### 2.2 页面链路（四份真实页面 DOM）

业务方按顺序抓取了 `1.html` → `2.html` → `3.html` → `4.html`（worktree 根目录）。**这四份快照已于 2026-10-09 全部删除**（含真实店铺数据，且未被 `.gitignore` 覆盖）；所需的选择器与判据已全部提炼进本文，其中弹窗本体保留为脱敏夹具 `python/lxeskill_cli/tests/amazon/fixtures/delivery_window_modal.html`：

| 文件 | 是什么 | 关键证据 |
| --- | --- | --- |
| `1.html` | 货件一览（Amazon shipment hub 列表页） | `data-hub-key="shipment_hub"`；9 列 × 25 行；`data-row-id` **就是 FBA 货件号** |
| `2.html` | 货件详情页（「货件一览」面板） | `[data-testid="shipment-info-details"]` 内的 `kat-link[href*="/fba/sendtoamazon?wf="]`（该链接**无 testid**） |
| `3.html` | Send to Amazon 最后一步「追踪详情」模态 | 工作流 `wf972136a3-771c-4e7b-bd36-19936407d07d`；5 个货件分页；`[data-testid="shipment-tracking-tab"]` |
| `4.html` | 点开 `(编辑时段)` 后的弹窗（内含整个 3.html） | 选中的是货件编号 5 = `FBA19PKKBQ4N`，时段 `2026年10月11日 - 2026年10月17日` |

**`4.html` 的弹窗骨架（全部可用 `data-testid` 定位）**

```
article#sta-modal[data-testid="sta-modal"]         class: dialog-width-50-percent ship-delivery-window-modal
└─ kat-modal[data-testid="modal-overlay"]          role=dialog
   ├─ [data-testid="modal-header"]                 「更改送达时段」
   ├─ [data-testid="edit-delivery-window-modal-body"]
   │  ├─ kat-alert header                          「在 2026年10月11日 之前可编辑」
   │  ├─ [data-testid="delivery-window-info-text"]
   │  ├─ 「当前送达时段」→ 2026年10月11日 - 2026年10月17日
   │  ├─ 「新的送达时段」→ kat-calendar[data-testid="edit-delivery-window-calendar"]
   │  │                      locale="zh-CN" value="1791648000000"
   │  └─ [data-testid="delivery-window-modal-legend-item"] ×2
   │        ①「已选择」    class ac-delivery-window-modal-legend-selected
   │        ②「配送时段不可用」class ac-delivery-window-modal-legend-unavailable
   ├─ [data-testid="FIST_ShipTrack_Manage_Delivery_Window_Note"]
   └─ [data-testid="edit-delivery-window-modal-footer"]
      ├─ [data-testid="edit-delivery-window-modal-cancel-button"]   label 取消
      └─ [data-testid="edit-delivery-window-modal-update-button"]   label「确认新的送达时段」
                                                                    初始 disabled="true"
```

- `value="1791648000000"` → 本地(UTC+8) 2026-10-11 00:00 / UTC 2026-10-10 16:00 = 当前时段开始日。
- **弹窗 DOM 只在点开后渲染**：`sta-modal` / `ship-delivery-window-modal` / `edit-delivery-window-modal-body` / `edit-delivery-window-calendar` / `edit-delivery-window-modal-update-button` / `edit-delivery-window-modal-cancel-button` / `delivery-window-info-text` / `FIST_ShipTrack_Manage_Delivery_Window_Note` 在 `1/2/3.html` **全部 0 命中**，只在 `4.html` 出现。
- `kat-calendar` 在 `outerHTML` 里**是空的**（日期格子渲染在 shadow root 内）⇒ 静态抓取拿不到；运行时用 `SHADOW_DOM_HELPERS_JS` 的 `deepQuerySelectorAll` 递归穿刺。
- **注意**：浏览器「Copy outerHTML」**不包含 Shadow DOM 内容**。本页单元格是 light DOM（所以抓得到），若将来移入 shadow root 则必须改用截图或实时读取。

### 2.3 「未接收」的口径（已定）

`1.html` 的 `data-column-id="unitStatus"`（表头 `商品状态`，子标签 `已入库 / 预计上架`，`data-cell-type="Fraction" data-cell-variant="bar"`）：

- 斜杠左 = **已入库**（tip 文案：「货物送达首个亚马逊运营中心并完成入库登记后，即可转为可售库存」）
- 斜杠右 = **预计上架**（tip 文案：「商品转移并存放在运营中心后，便可符合 Prime 要求」）
- ⇒ 这一列量的是「**入库 → 转运上架**」两段流水线的进度，**不是「到货与否」的开关**。

**判定口径：未接收货件 = `已入库 < 预计上架`。**

选它而不选 `已入库 = 0` 的两个理由：

1. 它是 `已入库 = 0` 的**超集**，只会多不会漏。
2. 业务方自己走通流程的那两票都是「少几件」（`3.html` 是 `600/602`、`4.html` 是 `601/602`），按 `= 0` 筛**一票都不会被选中**。

**两个反直觉的坑（已证伪的错误假设）**

- 「页面里的进度条涂满 = 全部接收」——**错**。提取 25 行的 `<progress>` 后：`600/602`、`601/602` 是 `complete`（涂满），而 `451/454`(99%)、`419/424`(99%)、`407/461`(88%) 是 `progress`。进度条按百分比四舍五入（≥99.5% 涂满），**不能当判据**，只能看那两个数字。
- 「`已入库 > 0` 说明货已到仓、窗口已锁」——**错**。反例：`FBA19PKKBQ4N` 是 `601/602`，其弹窗仍写着「在 2026年10月11日 之前可编辑」。**锁死与否只认页面上那句 `在 <日期>, 00:00 UTC 之前`**。

### 2.4 窗口长度实测（不能假定 7 天）

对 `1.html` 25 票的实际时段做了星期对齐：

- **23 票精确是周日 → 周六、7 天**。
- **2 票是 14 天**：
  - `FBA19QT6571T` → `2026-10-23(五) – 2026-11-05(四)`（起始不是周日）
  - `FBA19L3SBMJ1` → `2026-09-06(日) – 2026-09-19(六)`

⇒ **必须从页面读实际的开始/结束日**，不能自己按 7 天或「本周日」推算。已落地的 `delivery_window_list.py` 正是读实际文本并算 `span_days`，此处无坑。

## 3. 输入契约

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `store_id` | ✅ | 紫鸟店铺 oauth（来自用户或 `lxeskill browser store --action get_status`） |
| `shipment_ids` | ✅ | FBA 货件号数组，形如 `FBA19PKKBQ4N`（`^FBA[A-Z0-9]{7,}$`）。**逐个独立处理** |
| `target_date` | ✅ | `2026-10-28` 或 `10.28` 均可；折算成**所在日历周**（周日 → 周六） |
| `apply` | ➖ | 默认 `false`。`false` = dry-run：只读到「准备从 X 改到 Y」并返回，不点任何东西 |

对应业务原话「帮我把未配送的商品 FBA号：XXXXXX 配送时间修改为10.28」——`shipment_id` + `target_date` 就是全部输入，**业务不需要算周**。`10.28` 是星期三 ⇒ 目标周 = `10月25日(周日) – 10月31日(周六)`。

## 4. 执行链

优先 URL，失败再回退 DOM 点击链；两条路最终收敛到同一组选择器。

```
①  打开店铺          browser_session(store_id)                  需 LXE_AGENT_SESSION_ID
②  前置校验「未接收」 列表页读 unitStatus                          已入库 < 预计上架，否则拒绝
③  进详情页          URL: /fba/inbound-shipment/summary/<FBA_ID>/contents
④  进 STA 追踪详情    URL: /fba/sendtoamazon?wf=<wf>   ← 待实测
                       回退：[data-testid="shipment-info-details"]
                             kat-link[href*="/fba/sendtoamazon?wf="]
⑤  选中该货件分页     [data-testid="shipment-tracking-tab"]，按分页内 FBA 号文本匹配
⑥  读当前时段与截止   [data-testid="edit-delivery-window-grace-period"] → 解析截止时刻
                       「送达时段:」容器的直属文本节点 → 当前周
⑦  判可编辑          截止 > now(UTC)，否则硬失败并原样报出页面文案
⑧  点 (编辑时段)      [data-testid="edit-delivery-window-link"]
                       → 等 [data-testid="edit-delivery-window-modal-body"]，超时 = 硬失败
──────────── dry-run 到此返回 {当前周, 目标周, 截止时刻} ────────────
⑨  日历点目标日       [data-testid="edit-delivery-window-calendar"] 内（格式照抄 own_carrier.py:1220）
⑩  自检               回读 [data-testid="delivery-window-modal-legend-item"] 的「已选择」文本
                       ≠ 目标周 → 停，绝不点确认
⑪  确认               [data-testid="edit-delivery-window-modal-update-button"]
⑫  回读验证           页面上的时段 == 目标周 → 成功；不一致 → 显式报失败
```

读取「送达时段」**必须只取容器的直属文本节点**：tooltip 文案与链接文本都在同一个 `div` 内，整块取会被污染。

## 5. 六道硬失败（宁可没改成，也不能写错）

| # | 触发条件 | 动作 |
| --- | --- | --- |
| 1 | ② 该票 `已入库 >= 预计上架` | 拒绝，返回页面读数 |
| 2 | ⑤ 分页里的 FBA 号 ≠ 请求的 | 停 |
| 3 | ⑦ grace 截止已过 | 停，原样回传页面文案 |
| 4 | ⑧ 弹窗超时未出现 | 停（很可能是被承运人预约锁定） |
| 5 | ⑩ 图例「已选择」≠ 目标周 | **停，不点确认** |
| 6 | ⑪ 确认按钮仍 `disabled` | 停 |

**显式返回**（业务要求）：dry-run 与 apply 都返回 `{货件号, 当前时段, 新时段, 可编辑截止}`；apply 之后还要返回**回读到的实际时段**。dry-run 与 apply 走同一条读路径，因此「返回的东西」与「真要写的东西」不会分叉。

## 6. 选择器清单

### 6.1 真实页面已验证（2026-10-09 四份快照逐字命中；快照已删，记录保留）

- `[data-hub-key="shipment_hub"][data-row-id]`
- `[data-column-id="deliveryWindow"]`、`[data-column-id="unitStatus"]`
- `[data-atom-id="primary"]`
- `[data-testid="shipment-info-details"] kat-link[href*="/fba/sendtoamazon?wf="]`
- `[data-testid="shipment-tracking-tab"]`
- `[data-testid="edit-delivery-window-link"]`（label `(编辑时段)`）
- `[data-testid="edit-delivery-window-grace-period"]`
- `[data-testid="edit-delivery-window-tooltip"]`
- `[data-testid="edit-delivery-window-modal-body"]`
- `[data-testid="edit-delivery-window-calendar"]`
- `[data-testid="delivery-window-modal-legend-item"]`
- `[data-testid="edit-delivery-window-modal-update-button"]`
- `[data-testid="edit-delivery-window-modal-cancel-button"]`

### 6.2 待运行时验证（3 条，都会以明确错误暴露，不会静默错写）

1. `kat-calendar` 内的日期格子 —— 既有实现假定 `button[aria-label^="YYYY年M月D日"]`，但那套组件是 `kat-date-picker`，我们的是 `kat-calendar`。
2. 月份翻页 `[part="calendar-next-month"]` / `.cal-month` 在 `kat-calendar` 内是否同名。
3. 「确认新的送达时段」从 `disabled="true"` 变为可点的条件。

### 6.3 已知的判据陷阱

- `[data-testid="edit-delivery-window-tooltip"]` 在 `3.html`（时段 9月27日已过、锁死）与 `4.html`（时段 10月11日未到、可编辑）**都渲染、文案相同** ⇒ **tooltip 是否存在不能用来判断可编辑性**。
- 可编辑性只认 `[data-testid="edit-delivery-window-grace-period"]` 里的日期（3.html 是「在 2026年9月27日, 00:00 UTC 之前」= 已过；4.html 是「在 2026年10月11日, 00:00 UTC 之前」= 未到）。

### 6.4 明确不要用的选择器

| 位置 | 内容 | 为什么不用 |
| --- | --- | --- |
| `python/lxeskill_cli/services/agent_cli/browser/amazon_common/own_carrier.py:39` | `_DELIVERY_WINDOW_LINK_SELECTOR = '[data-testid="arrival-edit-delivery-window-link"]'` | 在 `1/2/3/4.html` **0 命中**；真实值是 `edit-delivery-window-link`（少 `arrival-` 前缀） |
| `python/lxeskill_cli/services/agent_cli/browser/amazon_common/own_carrier.py:1096` | `_click_delivery_window_modal_confirm_button` | **全文件无调用点（死代码）**，且其选择器 `[data-testid="delivery-window-modal-confirm-button"]`（`:26`）在真实弹窗里不存在；它会 fallback 到 `:1092` `_click_update_button`（按文本「更新」找），而弹窗按钮文案是「确认新的送达时段」→ 静默失败 |

**例外（可复用）**：`own_carrier.py:1220-1291` 的日历日期选择链路是**已上线、有测试**的实现，本文的 ⑨⑩ 步照抄它：

- `_click_calendar_day(driver, target_date)`（`:1220-1270`）：`label_prefix = f"{target_date.year}年{target_date.month}月{target_date.day}日"`，遍历 `button[aria-label]` 用 `startsWith(labelPrefix)` 命中，跳过禁用项（`button.disabled` / `aria-disabled === 'true'` / `deepClosest(button,'td')` 的 `cell.classList.contains('disabled')`），再依次 dispatch `pointerdown/mousedown/pointerup/mouseup/click` 并 `el.click()`（Katal 组件不响应裸 click）。
- `_calendar_day_selected(driver, target_date)`（`:1271-1291`）：检查 `aria-pressed === 'true'` 或 button/td `classList.contains('selected')`。
- 月份：`_CALENDAR_MONTH_SELECTOR = ".cal-month"`、`_CALENDAR_PREV_SELECTOR = '[part="calendar-prev-month"]'`、`_CALENDAR_NEXT_SELECTOR = '[part="calendar-next-month"]'`（`:45-47`）；`_parse_calendar_month_label`（`:1626-1650`）支持 `2026年10月` 与汉字月名。
- **作用域化写法（本任务要采用）**：既有 `_click_calendar_day` 是**全页搜索**，而我们的弹窗嵌在有大量其他组件的页面里，应作用域到 `kat-calendar[data-testid="edit-delivery-window-calendar"]`，复用 `_PHASE_3_2_DATE_PICKER_SCOPE_JS`（`:759` 起）里的 `scopedQuerySelectorAll(selector, root)` 写法。
- 测试契约：`python/lxeskill_cli/tests/amazon/test_own_carrier_layouts.py:987` `test_click_calendar_day_uses_prefix_match_and_skips_disabled` 断言 `label_prefix == "2026年5月20日"` 且脚本含 `startsWith(labelPrefix)` / `aria-disabled` / `classList.contains('disabled')` / `pointerdown`。

## 7. 代码落点

**新增**

- `python/lxeskill_cli/services/agent_cli/browser/amazon_fba/delivery_window_apply.py` —— 写路径命令入口
- `python/lxeskill_cli/tests/amazon/test_delivery_window_apply.py`

**已存在（复用，不改）**

- `python/lxeskill_cli/services/agent_cli/browser/amazon_fba/delivery_window_list.py` —— 列表页只读，580 行；其 `parse_cn_date` / `parse_delivery_window` **纯函数直接复用，不重写解析**
- `python/lxeskill_cli/services/agent_cli/browser/amazon_fba/_shared.py` —— `run_stage` / `result_with_details` / `not_ready_result`
- `python/lxeskill_cli/services/agent_cli/_shared/browser_session.py` —— `browser_session(*, session_id, context, output_dir)`
- `python/lxeskill_cli/services/browser/workflows/amazon_fba_common.py` —— `WorkflowBrowserSession` / `workflow_output_dir(session_id)`
- `python/lxeskill_cli/services/browser/browser/shadow_dom.py` —— `SHADOW_DOM_HELPERS_JS`

**约定**

- 选择器常量集中在文件顶部（照 `own_carrier.py` 的写法）
- 异常统一 `f"{type(exc).__name__}: {exc}"` 原样回传，不包装（错误真实性）
- 产物落 `workflow_output_dir(session_id)`，确保在 `artifact_root()` 内（满足 `allowed_output_file`）

## 8. 测试策略

- **纯函数单测**：日期 → 日历周（含 2 个 14 天例外，不能硬套 7 天）、grace 文本解析、分页匹配、图例校验。
- **假 driver 契约测**：断言注入脚本里出现了正确的选择器；**断言 `apply=false` 时全程没碰过日历和确认按钮**。
- **真实 DOM 夹具测**：用 `python/lxeskill_cli/tests/amazon/fixtures/delivery_window_modal.html`（脱敏自 `4.html` 的 `article#sta-modal`，3,479 字节，无货件号/工作流号/邮箱）验证三件容易写错的事：①「送达时段:」只取**直属文本节点**（tooltip 文案在同一 `div` 内，整块取会被污染）② grace 截止时刻解析 ③ 图例「已选择」与更新按钮 `disabled="true"` 的读取。用已声明的 `beautifulsoup4`（`pyproject.toml:9`），**不新增依赖**。
  - **该夹具故意不入库**（已由 `.gitignore:85` 忽略，只存在于本机），因此这个测试在夹具缺失时必须 `pytest.skip`，不能让别人的 checkout / CI 变红。
  - 夹具的**局限**：里面的 `kat-calendar` 是空的（日期格子在 shadow root 内），所以它**不覆盖**「日历格子怎么点」——见 §6.2 第 1 条，那步只能运行时验证。
- 从仓库根运行：`UV_CACHE_DIR="${TMPDIR:-/tmp}/lxe-uv-cache" uv run pytest python/lxeskill_cli/tests/amazon -q`
  - **裸 `uv run` 会因 `~/.cache/uv` 在沙箱外不可写而 rc=2**，必须带 `UV_CACHE_DIR`。
- 跑 lxeskill 命令必须允许写数据根 `<repo>/var`，否则 `setup_logging()` 最早就抛 `PermissionError: [Errno 1] Operation not permitted: .../var/logs/runtime/<日期>/runtime-py.log`。

## 9. 刻意不做

- ❌ 「已损失」清单 / 绩效报表 —— 业务决定：**只负责改日期，其余无关**。
- ❌ 货代侧任何抓取 —— 人直接给日期，整段砍掉。
- ❌ 批量改同一工作流里的其他货件 —— 官方说每个货件独立，用户给哪个改哪个。
- ❌ SP-API（读与写）。
- ❌ 紫鸟的 `browser_snapshot` / `browser_click` ref 原语（非确定性、无法 dry-run）。

## 10. 待定项

| # | 待定 | 影响 |
| --- | --- | --- |
| 1 | **本机验证路径**：(A) 设备接入内网/VPN 拿 FBA 权限快照；还是 (B) 走 `apps/agent-cli` | 决定能不能真跑 |
| 2 | `④` 的 URL 形态：`/fba/sendtoamazon?wf=` 与 `/fba/sendtoamazon/workflows?wf=` 哪个能直接落在「追踪详情」 | 决定走 URL 还是回退点击 |
| 3 | `catalog.json` 条目与 `skills/fba-shipment-delivery-window/SKILL.md` 的字段（命令名 / `command_path` / `visibility` / `session_mode` / `owner_skills` / `artifact_paths`） | 等本文定稿后再定 |
| 4 | 仓库卫生：新文件怎么切提交；`own_carrier.py:39` 与 `:1096` 修不修 | 提交前必办 |

**已定**：`delivery_window_modal.html` 夹具**不入库**，由 `.gitignore` 忽略；用它的测试在文件缺失时 `pytest.skip`（见 §8）。

**关于待定项 1 的事实基础**：`_require_in_scope()` 的调用点在 `python/lxeskill_cli/lxeskill/cli.py:362`（`_run_entry`），**module 型与 handler 型条目都要过这一关**——「自己写模块」并不能绕过它。`_scope_allows`（`python/lxeskill_cli/lxeskill/cli.py:335-347`）只有三种放行：`LXESKILL_SKILL_SCOPE` 变量不存在（人的终端）、`visibility` ∈ {maintenance, internal}、`owner_skills` 为空。

- 新 skill 按约定写 `type: amazon_fba`，即跟现行 FBA 权限模板走：`apps/desktop/src/main/cloud-permissions.ts:11-24` 里 `fba` → `skillTypes: ["amazon_fba","ziniao_browser","default"]`，**不需要新通道**。
- 但本机 `var/config/settings.json` 里**没有 `cloud_permission_snapshot`** ⇒ 桌面端 `allowedSkillTypes = []` ⇒ scope 为空 ⇒ 一切 business / browser 命令报 `skill_not_in_scope`。
- `apps/agent-cli/src/exec-command.ts:451` 写死 `allowedSkillTypes: new Set(["*"])` ⇒ 走这条一次性入口不需要云，但要自己注入紫鸟的 env。

## 11. 红线与纪律（只引用，不复制）

- 紫鸟店铺的页面级操作**只能**走官方配对 Selenium：`docs/harness/skill/reference/ziniao-webdriver-doc-1.0.0/reference/automation-framework-policy.md`（明确禁止 Playwright / Puppeteer / DrissionPage / 裸 CDP 用于本项目的页面读取、截图或交互）。
- 失败时原样带出 Amazon 的真实错误，不包装。
- 不新增 Python 自有表。
- 提交、测试、worktree 流程一律照 `AGENTS.md`。

## 12. 证据索引

**仓库内**

- `docs/record/20261007-fba-delivery-window.md`（本文的前身）
- `python/lxeskill_cli/services/agent_cli/browser/amazon_common/own_carrier.py`（日历实现可复用的唯一先例：`:1220-1291`、`:45-47`、`:759`、`:1626-1650`；**`:39` 与 `:1096` 不可用**）
- `python/lxeskill_cli/services/agent_cli/browser/amazon_fba/delivery_window_list.py`
- `python/lxeskill_cli/tests/amazon/test_delivery_window_list.py`、`python/lxeskill_cli/tests/amazon/test_own_carrier_layouts.py`
- `python/lxeskill_cli/lxeskill/catalog.json`、`skills/fba-shipment-create/SKILL.md`
- 真实页面 DOM 快照：`1.html`、`2.html`、`3.html`、`4.html`（2026-10-09 由业务方抓取，**同日已删除**——含真实店铺数据且未被 `.gitignore` 覆盖；选择器与判据已全部提炼进本文）
- 弹窗夹具（脱敏，保留）：`python/lxeskill_cli/tests/amazon/fixtures/delivery_window_modal.html`（3,479 字节）

**外部**

- Amazon 官方帮助「Send to Amazon：送达时段 - 采用标准日历周」（`sellercentral.amazon.com/help/hub/reference/external/G4ZKN4DCCXL5XQWJ`）——业务方于 2026-10-09 提供全文；**该页与同类 sellercentral 帮助页/论坛页用抓取工具只能拿到 HTTP 200 + 空正文（JS 渲染）**。
- 送达时段规则转述：`https://www.52by.com/article/196319`（2025-09-08）
- 2023 年首次强制与定义：`https://www.kuajingyan.com/article/27866`
- 「未接收」口径（第三方工具文档）：`https://www.revenuealot.com/zh/docs/amazon-inbound-shipments`
- 绩效影响与判定节点（自媒体）：`https://www.amz123.com/t/z9mUw5Mk`
