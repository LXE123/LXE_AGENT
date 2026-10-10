# FBA 货件送达时段「改期」方案（浏览器路径）

- 状态：**写路径、真实写入验证与正式命令注册均已完成**（2026-10-10）。`python/lxeskill_cli/services/agent_cli/browser/amazon_fba/delivery_window_apply.py` + 定向单测 101 条全绿；紫鸟本地控制、目标店铺启动、官方配对 Selenium 附着、单票 dry-run、真实确认提交和 E8 页面回读均已打通。首次 R3 暴露并修正了 `unitStatus=516/516` 误判“接收完成”的 E1 逻辑；后续真实页面又确认 STA 工作流程可能折叠「最后一步：追踪详情」，且一个工作流程下有动态数量的目的地子货件。根据销售部门最终口径，生产候选必须先满足 `orderStatus="已发货"`；`正在接收` 即使页面存在编辑入口也只作技术证据，不再进入修改流程。正式入口为 `lxeskill fba shipment delivery-window-list` 与 `lxeskill fba shipment delivery-window`，模型说明位于 `skills/fba-shipment-delivery-window/SKILL.md`（见 §15.14）。
- 日期：2026-10-09（2026-10-10 按真机结果回写 §10 / §12 / §13 / §14，并新增 §15）
- 结论先行：**要改的确实是 Amazon 侧的送达时段**，但**不需要 SP-API**（写路径也不止 SP-API 一条）。因为业务直接给目标日期，整条「去货代后台查转单号 → 到尾程派送商查实际时间」的链路被砍掉。真正要做的是：**读 Amazon 列表确认货件状态为“已发货” → 在「追踪详情」继续验证可编辑性 → 在弹窗日历上选目标日 → 确认**，全程走官方配对 Selenium。

## 1. 与 2026-10-07 方案的差异

| 20261007 方案 | 本文 | 原因 |
| --- | --- | --- |
| §3.1 可替换数据源适配器 `FbaShipmentSource`（A 浏览器 / B SP-API） | **只做浏览器路径，不引入适配器层** | 业务直接给日期，读+写都能在页面里完成；SP-API 要开发者身份 + 凭据 + 桌面配置，周期最长 |
| §3.2 两条命令 `list` / `apply` | 保留，并于 2026-10-10 注册为 `delivery-window-list` / `delivery-window` | — |
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

### 2.3 列表状态与数量口径（2026-10-10 真机修正）

列表页实际有两个不同含义的状态字段：

- `data-column-id="orderStatus"`：可见的货件生命周期状态，例如 `正在接收`。
- `data-column-id="unitStatus"`：`已入库 / 预计上架` 数量条，`data-cell-type="Fraction" data-cell-variant="bar"`。

`unitStatus` 的含义：

- 斜杠左 = **已入库**（tip 文案：「货物送达首个亚马逊运营中心并完成入库登记后，即可转为可售库存」）
- 斜杠右 = **预计上架**（tip 文案：「商品转移并存放在运营中心后，便可符合 Prime 要求」）
- ⇒ 这一列量的是「**入库 → 转运上架**」两段流水线的进度，**不是货件生命周期或送达时段可编辑性的开关**。

2026-10-10 对 `FBA19QP2RBT8` 的真机读取给出了直接反例：同一行 `orderStatus="正在接收"`，同时 `unitStatus="516/516"`。旧代码据 `516/516` 报“已经接收完成”并在 E1 停止，属于误拦截。

**最终判定口径（2026-10-10 按销售部门答复再次收紧）**：

1. E1 先读取列表中的 `orderStatus`；只有精确为 `已发货` 才能成为修改候选。`正在接收`、`已完成`、`在途`及未知状态均不得进入修改流程。
2. `unitStatus`（例如 `0/172`、`516/516`）只作数量诊断，不参与候选判断；`已发货 + 0/172` 仍应继续检查。
3. 通过 E1 后，还必须同时通过追踪详情的真实页面事实：正确货件分页、当前送达时段、grace 截止时间、编辑入口和弹窗（E2–E4）。
4. `action=discover` 会动态返回全部子货件，但只对 `已发货` 子货件检查页面可编辑性；其他状态返回 `ineligible`，不会切换到对应分页。列表中找不到对应子货件或读不到状态则返回未知，禁止猜测。
5. 操作下拉存在“追踪货件”只证明追踪入口存在，不等于送达时段仍可编辑。

**三个反直觉的坑（已证伪的错误假设）**

- 「页面里的进度条涂满 = 全部接收」——**错**。提取 25 行的 `<progress>` 后：`600/602`、`601/602` 是 `complete`（涂满），而 `451/454`(99%)、`419/424`(99%)、`407/461`(88%) 是 `progress`。进度条按百分比四舍五入（≥99.5% 涂满），**不能当判据**，只能看那两个数字。
- 「`已入库 > 0` 说明货已到仓、窗口已锁」——**错**。反例：`FBA19PKKBQ4N` 是 `601/602`，其弹窗仍写着「在 2026年10月11日 之前可编辑」。**锁死与否只认页面上那句 `在 <日期>, 00:00 UTC 之前`**。
- 「`已入库 = 预计上架` 说明货件生命周期已完成」——**错**。反例：`FBA19QP2RBT8` 是 `516/516`，可见 `orderStatus` 仍为“正在接收”。

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
| `action` | ➖ | 默认 `apply`。`discover` = 用一个种子 FBA 号定位 STA 工作流程，动态读取其中全部目的地子货件及可编辑状态，全程不打开编辑弹窗；`apply` = 对明确选择的货件走既有 dry-run/写入路径。 |
| `store_id` | ✅ | 紫鸟店铺 oauth（来自用户或 `lxeskill browser store --action get_status`） |
| `page_url` | ✅ | **货件列表页的绝对 http(s) 地址**（就是平常打开「货件一览」那个页面）。站点 origin 和列表页都由它承载：② 的 `orderStatus` / `unitStatus` 要在这个页面读，③④ 的详情页 URL 要用它的 origin 拼。 |
| `shipment_ids` | ✅ | FBA 货件号数组，形如 `FBA19PKKBQ4N`（`^FBA[A-Z0-9]{7,}$`）。**逐个独立处理** |
| `target_date` | ✅ | `2026-10-28` 或 `10.28` 均可；折算成**所在日历周**（周日 → 周六） |
| `apply` | ➖ | 默认 `false`。`false` = dry-run：只读到「准备从 X 改到 Y」并返回，不点任何东西 |
| `timeout_sec` | ➖ | 默认 `60`，允许 `1–600`。页面等待（列表页出行、STA 分页出现）用这个上限 |
| `plan_only` | ➖ | 默认 `false`。`true` = 只校验参数就返回，完全不碰浏览器（快速自检用） |

`action=discover` 时，`shipment_ids` 必须且只能提供一个种子 FBA 货件号，`target_date` 不需要提供，且禁止 `apply=true`。程序从该货件详情进入所属 STA 工作流程，读取页面实际存在的全部 `[data-testid="shipment-tracking-tab"]`；数量不写死为 5。每个分页必须唯一解析出一个完整 FBA 号，随后逐页只读当前时段、grace 截止时间和编辑入口，返回 `editable / locked / unavailable / unknown`。其中 `editable=true` 必须同时满足：当前时段可解析、grace 未过期、页面存在且没有 `disabled/aria-disabled=true` 的编辑入口。

对话层在 discovery 结果上接受自然语言选择，但真正调用 `action=apply` 前必须把选择标准化为完整 FBA 号和目标日期清单，再向用户确认一次；不能把“页面可编辑”直接当成用户授权。

对应业务原话「帮我把未配送的商品 FBA号：XXXXXX 配送时间修改为10.28」——`shipment_id` + `target_date` 就是全部输入，**业务不需要算周**。`10.28` 是星期三 ⇒ 目标周 = `10月25日(周日) – 10月31日(周六)`。

> `page_url` 是**实现时补上的**：原方案 §4 ② 要读列表页、③④ 要拼详情页与 STA 地址，但输入表里没有任何东西能告诉程序「这是哪个站点、列表页在哪」，所以必须补一个入口地址。它沿用 `delivery_window_list.py` 的同名参数与校验（不是绝对 http(s) 就报 `page_url 必须是绝对 http(s) 地址（Amazon 货件列表页），收到: …`），没有引入第二个站点参数。

## 4. 执行链

优先 URL，失败再回退 DOM 点击链；两条路最终收敛到同一组选择器。

```
①  打开店铺          browser_session(store_id)                  需 LXE_AGENT_SESSION_ID
②  列表状态校验      用入口参数 page_url 打开货件列表页，确认目标行存在并读取 orderStatus（E1）
                       unitStatus 只记入诊断，不作为进入下一步的门槛
③  进详情页          URL: /fba/inbound-shipment/summary/<FBA_ID>/contents
④  进 STA 追踪详情    URL: /fba/sendtoamazon?wf=<wf>
                       回退：[data-testid="shipment-info-details"]
                             kat-link[href*="/fba/sendtoamazon?wf="]
                       若分页未出现：在多个 [data-testid="step-view-link"] 中，
                       按最近祖先文本精确定位「最后一步：追踪详情」的「查看」并展开；
                       禁止按第几个链接盲点
⑤  选中该货件分页     [data-testid="shipment-tracking-tab"]，按分页内 FBA 号文本匹配
                       还必须能确认「目标分页确实选中了」，确认不了就停（E2）
⑥  读当前时段与截止   grace 优先 [data-testid="edit-delivery-window-grace-period"]；
                       取不到就退到页面/弹窗里那句「在 <日期>[, HH:MM UTC] 之前」
                       「送达时段」标签所在元素的直属文本节点 → 当前周
⑦  判可编辑          截止 > now(UTC)，否则硬失败并原样报出页面文案（E3）
⑧  点 (编辑时段)      [data-testid="edit-delivery-window-link"]
                       → 等 [data-testid="edit-delivery-window-modal-body"]，超时 = 硬失败（E4）
                       → 弹窗里再读一次「当前送达时段」，与点开前不一致 = 读错了货件（E9）
────────── dry-run 到此返回 {当前周, 目标周, 截止时刻}，并尽力点一次「取消」 ──────────
⑨  日历点目标日       [data-testid="edit-delivery-window-calendar"] 内（格式照抄 own_carrier.py:1220）
                       翻月必须「先读月份标题 → 翻 → 翻完复读」，点不动或月份没变就停（E7）
⑩  自检               回读 [data-testid="delivery-window-modal-legend-item"] 的「已选择」文本
                       ≠ 目标周 → 停，绝不点确认（E5）
⑪  确认               [data-testid="edit-delivery-window-modal-update-button"]（仍 disabled → 停，E6）
⑫  回读验证           页面上的时段 == 目标周 → 成功；不一致 → 显式报失败（E8）
```

读取「送达时段」**必须只取容器的直属文本节点**：tooltip 文案与链接文本都在同一个 `div` 内，整块取会被污染。

**两条实现约定**（写代码时定的，避免无意义的点击与误报）：

- **已经就是目标周就别点**：读到的当前周 == 目标周时，dry-run 与 apply 都**不点开弹窗**，直接返回 `already_target`。
- **dry-run 只到 ⑧**：点开「(编辑时段)」不算改动，所以 dry-run 允许点它；点完读到期段就**尽力点一次「取消」**并记录成功与否，**绝不点日历、绝不点月份翻页、绝不点确认按钮**。

## 5. 硬失败清单（宁可没改成，也不能写错）

代码里用 **E1–E9** 编号，报错时原样带上编号和页面读数，便于对着本表排查。**任何一条触发，都不点确认按钮。**

| 码 | 触发条件（对应 §4 步骤） | 动作 |
| --- | --- | --- |
| E1 | ② 列表页一行都没读到；该票不在本页；目标行的 `orderStatus` 读不到 | 该票拒绝并返回页面读数；`unitStatus` 只作诊断，**列表页本身失败则一票都不碰** |
| E2 | ④ 详情页找不到 STA 链接、点了也进不去；⑤ 分页里没有这票 FBA 号、或有多条分不清；点完分页后**无法确认它已选中** | 停 |
| E3 | ⑥⑦ grace 读不到 / 解析不出 / 截止已过 | 停，原样回传页面文案 |
| E4 | ⑧ 编辑链接点不动；弹窗超时未出现 | 停（很可能是被承运人预约锁定） |
| E5 | ⑩ 图例「已选择」≠ 目标周 | **停，不点确认** |
| E6 | ⑪ 确认按钮读不到或仍 `disabled` | 停 |
| E7 | ⑨ 月份标题读不到/解析不出；翻页点不动或月份没变；目标月里读不到日期格子；目标日点不动 | 停 |
| E8 | ⑫ 回读到的时段 ≠ 目标周 | 显式报失败，**原样带出实际读到的值**（最危险的一种） |
| E9 | ⑥ 当前「送达时段」读不出；⑧ 弹窗里的当前时段与点开前不一致 | 停（后者说明当前读的是别的货件分页） |

**显式返回**（业务要求）：dry-run 与 apply 都返回 `{货件号, 当前时段, 新时段, 可编辑截止}`；apply 之后还要返回**回读到的实际时段**。dry-run 与 apply 走同一条读路径，因此「返回的东西」与「真要写的东西」不会分叉。

**多票**：按请求顺序逐票独立处理；某票硬失败就停，后面的标 `not_attempted`（附「前一票 X 失败后停止」），已经写成功的如实记 `applied`。整次调用**不抛异常**，失败通过 payload 的 `exception` + 每票的 `failure_code` 表达。

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

**实现时按最坏情况兜的底**（都不会静默错写，最差是明确报 E7 / E6 停下）：

- 日期格子：作用域在 `kat-calendar[data-testid="edit-delivery-window-calendar"]` 内找 `button[aria-label^="YYYY年M月D日"]`；**一个都读不到就报 E7**，不会去猜别的写法。禁用判定照抄既有实现（`button.disabled` / `aria-disabled="true"` / 最近的 `td` 带 `disabled` 类）。
- 月份：标题先读 `.cal-month`，读不到退到 `[part="calendar-month"]`；翻月用 `[part="calendar-next-month"]` / `[part="calendar-prev-month"]`。**翻完必须复读月份标题，点不动或标题没变就报 E7**（最多试 24 次），宁可不翻也不乱点。
- 确认按钮：`disabled` 属性或 `aria-disabled="true"` 任一为真就报 E6，**不等它变可点**——等按钮启用会把「日历其实没选上」变成盲写。

### 6.3 已知的判据陷阱

- `[data-testid="edit-delivery-window-tooltip"]` 在 `3.html`（时段 9月27日已过、锁死）与 `4.html`（时段 10月11日未到、可编辑）**都渲染、文案相同** ⇒ **tooltip 是否存在不能用来判断可编辑性**。
- 可编辑性只认 `[data-testid="edit-delivery-window-grace-period"]` 里的日期（3.html 是「在 2026年9月27日, 00:00 UTC 之前」= 已过；4.html 是「在 2026年10月11日, 00:00 UTC 之前」= 未到）。
- **保留的弹窗夹具只覆盖第二种文案**：夹具里没有 `edit-delivery-window-grace-period`，那句截止时间在 `<kat-alert><span slot="header">在 2026年10月11日 之前可编辑</span>` 里，**没有 `, 00:00 UTC`**（`3.html` 那种带 UTC 的原文随快照一起删了）。所以代码**两种都要认**：先找 testid，找不到就在页面/弹窗里找「在 <日期>[, HH:MM UTC] 之前」这句；没有时刻时按当天 `00:00 UTC` 算，并在结果里标 `assumed_midnight_utc=true`。

### 6.4 明确不要用的选择器

| 位置 | 内容 | 为什么不用 |
| --- | --- | --- |
| `python/lxeskill_cli/services/agent_cli/browser/amazon_common/own_carrier.py:39` | `_DELIVERY_WINDOW_LINK_SELECTOR = '[data-testid="arrival-edit-delivery-window-link"]'` | 在 `1/2/3/4.html` **0 命中**；真实值是 `edit-delivery-window-link`（少 `arrival-` 前缀）⇒ 线上大概率点不到 |
| `python/lxeskill_cli/services/agent_cli/browser/amazon_common/own_carrier.py:1096` | `_click_delivery_window_modal_confirm_button` | 选择器 `[data-testid="delivery-window-modal-confirm-button"]`（`:26`）在真实弹窗里不存在；它会 fallback 到 `:1092` `_click_update_button`（按文本「更新」找），而弹窗按钮文案是「确认新的送达时段」→ 静默失败 |

**这两处不是「仓库卫生」级别的死代码，回写时已更正**：

- `:39` 那个选择器在**线上路径**里被用着：`own_carrier.py:637`、`:702`、`:750`。
- `:1096` 那个函数也**有调用点**：`own_carrier.py:1934`（phase-3.1 分支）。
- 所以原文「全文件无调用点（死代码）」的说法是错的；**结论（我们不要用）不变**，但它对现有 own carrier 流程是**真实的线上隐患**，不只是清理问题。按裁决本次**不改 `own_carrier.py`**，只在此更正记录（§10 待定项 4）。

**例外（可复用）**：`own_carrier.py:1220-1291` 的日历日期选择链路是**已上线、有测试**的实现，本文的 ⑨⑩ 步照抄它：

- `_click_calendar_day(driver, target_date)`（`:1220-1270`）：`label_prefix = f"{target_date.year}年{target_date.month}月{target_date.day}日"`，遍历 `button[aria-label]` 用 `startsWith(labelPrefix)` 命中，跳过禁用项（`button.disabled` / `aria-disabled === 'true'` / `deepClosest(button,'td')` 的 `cell.classList.contains('disabled')`），再依次 dispatch `pointerdown/mousedown/pointerup/mouseup/click` 并 `el.click()`（Katal 组件不响应裸 click）。
- `_calendar_day_selected(driver, target_date)`（`:1271-1291`）：检查 `aria-pressed === 'true'` 或 button/td `classList.contains('selected')`。
- 月份：`_CALENDAR_MONTH_SELECTOR = ".cal-month"`、`_CALENDAR_PREV_SELECTOR = '[part="calendar-prev-month"]'`、`_CALENDAR_NEXT_SELECTOR = '[part="calendar-next-month"]'`（`:45-47`）；`_parse_calendar_month_label`（`:1626-1650`）**只认「月名在前」的写法**（`十月 2026` ✓、`十月2026` ✓），对标准中文 `2026年10月` 会直接 `RuntimeError: 无法解析日历月份: 2026年10月`（`10月 2026`、`2026年 十月`、`2026年11月` 同样抛错，实测）⇒ **本任务的月份解析自己实现**（`parse_calendar_month_label`，年在前/月在前、汉字月名/数字月、以及 `2026年 10 月` 这类带空格的全认，全角数字先归一半角；读不出来就报 E7）。这条是这次唯二「不能照抄」的日历细节。
- **作用域化写法（本任务已采用）**：既有 `_click_calendar_day` 是**全页搜索**，而我们的弹窗嵌在有大量其他组件的页面里，必须作用域到 `kat-calendar[data-testid="edit-delivery-window-calendar"]`，写法照 `_PHASE_3_2_DATE_PICKER_SCOPE_JS`（`:759` 起）里的 `scopedQuerySelectorAll(selector, root)` 那套（先 `node.matches` / `node.querySelectorAll`，再递归 `child.shadowRoot`）。
- **它的 `clickElement` 有个坑**：事件参数只有 `{bubbles, cancelable, view}`，**缺 `composed: true`**，跨 shadow 边界可能失效；本任务的 `dispatchClick` 补上 `composed: true`，并带上元素的中点 `clientX/clientY`（Katal 组件对坐标敏感），其余顺序照抄（`pointerdown → mousedown → pointerup → mouseup → click`，最后再 `el.click()`）。这是第二处「不能照抄」的细节。
- 测试契约：`python/lxeskill_cli/tests/amazon/test_own_carrier_layouts.py:987` `test_click_calendar_day_uses_prefix_match_and_skips_disabled` 断言 `label_prefix == "2026年5月20日"` 且脚本含 `startsWith(labelPrefix)` / `aria-disabled` / `classList.contains('disabled')` / `pointerdown`。

## 7. 代码落点

**新增（已落地）**

- `python/lxeskill_cli/services/agent_cli/browser/amazon_fba/delivery_window_apply.py` —— 写路径命令入口
- `python/lxeskill_cli/tests/amazon/test_delivery_window_apply.py` —— 91 条定向单测

**已存在（复用，不改）**

- `python/lxeskill_cli/services/agent_cli/browser/amazon_fba/delivery_window_list.py` —— 列表页只读，580 行。实际复用的是：常量 `SHIPMENT_HUB_CELL_SELECTOR` / `PRIMARY_ATOM_SELECTOR` / `SHIPMENT_ID_COLUMN` / `DELIVERY_WINDOW_COLUMN`、`FBA_SHIPMENT_ID_PATTERN`、状态常量 `WINDOW_PARSED` / `WINDOW_MISSING` / `WINDOW_UNPARSED`、纯函数 `parse_delivery_window`、参数校验 `plan_read` 与异常 `DeliveryWindowArgumentError`。**解析一行都不重写。** 本模块新增 `ORDER_STATUS_COLUMN = "orderStatus"` / `UNIT_STATUS_COLUMN = "unitStatus"`，并自写一个「读四列 + 带 `cellType`/`cellVariant`」的 hub 脚本。
- `python/lxeskill_cli/services/agent_cli/browser/amazon_fba/_shared.py` —— ⚠️ **不要用**。它的 `run_stage` / `result_with_details` / `not_ready_result` 是 `context_file` / `params_ready` 那一族，调用者只有 `confirm_own_carrier.py:25`、`enter_tracking_codes.py:25`、`prepare_multi_box_excel.py:24`、`prepare_upload.py:24`，与 delivery-window 的 `success` / `finished` / `data` payload 形状**不兼容**（原稿写「复用这三个」是错的）。本模块照抄 `delivery_window_list._payload` 的五键形状。
- `python/lxeskill_cli/services/agent_cli/_shared/browser_session.py` —— `browser_session(*, session_id, context, output_dir)`
- `python/lxeskill_cli/services/browser/workflows/amazon_fba_common.py` —— `WorkflowBrowserSession` / `workflow_output_dir(session_id)`
- `python/lxeskill_cli/services/browser/browser/shadow_dom.py` —— `SHADOW_DOM_HELPERS_JS`（`deepQuerySelector` / `deepQuerySelectorAll` / `deepClosest`，点击与日历脚本都拼在它后面）

**读 / 写两条通道（实现时的关键选择）**

- **读页面**：`driver.page_source` + BeautifulSoup（`html.parser`，`beautifulsoup4` 已在 `pyproject.toml:9`，**没加依赖**）。好处是脱敏夹具走的**就是生产读路径**，测试不会测到一个镜像实现。
- **点击与等待**：注入 JS + `SHADOW_DOM_HELPERS_JS`（日历格子在 shadow root 里，读不到只能点）。shadow DOM 里的东西对管道不可见，所以「读不到」一律当响亮失败（E 码），不会猜。

**约定**

- 选择器常量集中在文件顶部（照 `own_carrier.py` 的写法）
- 异常统一 `f"{type(exc).__name__}: {exc}"` 原样回传，不包装（错误真实性）
- 产物落 `workflow_output_dir(session_id)`，确保在 `artifact_root()` 内（满足 `allowed_output_file`）

## 8. 测试策略

- **纯函数单测**：日期 → 日历周（含 2 个 14 天例外，不能硬套 7 天）、grace 文本解析、`unitStatus` 诊断解析、分页匹配与选中态判定、图例校验、月份标题解析。
- **假 driver 契约测**：断言注入脚本里出现了正确的选择器；**断言 `apply=false` 时全程没碰过日历、没翻过月份、没点过确认按钮**；断言 E1–E9 各自会显式返回而不是抛异常。
- **真实 DOM 夹具测**：用 `python/lxeskill_cli/tests/amazon/fixtures/delivery_window_modal.html`（脱敏自 `4.html` 的 `article#sta-modal`）验证三件容易写错的事：①「当前送达时段」只取**直属文本节点**（tooltip 文案与帮助链接文本在同一区块里，整块取会被污染）② grace 那句「在 2026年10月11日 之前可编辑」解析成截止时刻 ③ 图例「已选择」与更新按钮 `disabled="true"` 的读取。用已声明的 `beautifulsoup4`（`pyproject.toml:9`），**不新增依赖**。
  - **该夹具故意不入库**（已由 `.gitignore:85` 忽略，只存在于本机），因此这个测试在夹具缺失时必须 `pytest.skip`，不能让别人的 checkout / CI 变红。
  - 夹具实际是 **3,113 字节、单行**（原稿写 3,479）。它**没有** `edit-delivery-window-grace-period`、**没有** `edit-delivery-window-link`、**没有** 追踪分页 `shipment-tracking-tab`、**没有** `shipment-info-details`：所以截止时间只能从 `kat-alert` 那句读、⑧ 之后的步骤和 ② 的 `unitStatus` 都只能靠假 driver 的 HTML 覆盖。
  - 图例里那个 `ac-delivery-window-modal-legend-selected` 类挂在**孙辈的色块 `div` 上**，不在 `legend-item` 自己身上 ⇒ 识别「已选择」必须查后代，不能只看本元素的 class。
  - 夹具的**局限**：里面的 `kat-calendar` 是**空的**（日期格子在 shadow root 内），所以它**不覆盖**「日历格子怎么点」——见 §6.2 第 1 条，那步只能运行时验证。
- **跑法（2026-10-10 E1 修正后实测）**：`UV_CACHE_DIR="${TMPDIR:-/tmp}/lxe-uv-cache" uv run pytest python/lxeskill_cli/tests/amazon/test_delivery_window_apply.py -q` → **84 passed**。此前整个 `python/lxeskill_cli/tests/amazon` 的 320 passed 属于修正前记录，本次未重复跑全量，不能替代修正后的定向结果。
  - 测试里 `timeout_sec` 必须给成小值（本次用 1）。`_SLEEP` 被打桩成 no-op 时，「等一个永远不出现的元素」的等待会变成**忙等**，`timeout_sec` 还是默认 60 的话整个 pytest 会被挂死（`rc=137`，连 summary 都没有）。
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

| # | 待定 | 影响 | 现状 |
| --- | --- | --- | --- |
| 1 | **本机验证路径**：(A) 设备接入内网/VPN 拿 FBA 权限快照；还是 (B) 走 `apps/agent-cli` | 决定能不能真跑 | **已完成**：2026-10-10 同一套当前配置成功完成存活探测、`updateCore`、`getBrowserList`、目标店铺启动、官方配对 Selenium 附着、Amazon 登录态读取和真实单票写入。云接入状态是独立问题，不再作为 16851 / WebDriver 是否可用的判据。 |
| 2 | `④` 的 URL 形态：`/fba/sendtoamazon?wf=` 与 `/fba/sendtoamazon/workflows?wf=` 哪个能直接落在「追踪详情」 | 决定走 URL 还是回退点击 | **已验证 `/fba/sendtoamazon?wf=`**：真实流程成功进入对应 STA 工作流；追踪详情折叠时再精确展开“最后一步：追踪详情” |
| 3 | `catalog.json` 条目与 `skills/fba-shipment-delivery-window/SKILL.md` 的字段（命令名 / `command_path` / `visibility` / `session_mode` / `owner_skills` / `artifact_paths`） | 决定正式 Agent 入口 | **已完成**：两个命令均为 `business + lxe_session + amazon_fba`，owner 为 `fba-shipment-delivery-window`；JSON 证据声明为 `diagnostic`，不作为默认交付附件 |
| 4 | 仓库卫生：新文件怎么切提交；`own_carrier.py:39` 与 `:1096` 修不修 | 提交前必办 | **已裁决**：**不改 `own_carrier.py`**，只在 §6.4 更正记录；提交只带新模块 + 新测试 + 本文 |

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
- `python/lxeskill_cli/services/agent_cli/browser/amazon_fba/delivery_window_apply.py`、`python/lxeskill_cli/tests/amazon/test_delivery_window_apply.py`（本次新增）
- `python/lxeskill_cli/tests/amazon/test_delivery_window_list.py`、`python/lxeskill_cli/tests/amazon/test_own_carrier_layouts.py`
- `python/lxeskill_cli/lxeskill/catalog.json`、`skills/fba-shipment-delivery-window/SKILL.md`、`skills/fba-shipment-create/SKILL.md`
- 真实页面 DOM 快照：`1.html`、`2.html`、`3.html`、`4.html`（2026-10-09 由业务方抓取，**同日已删除**——含真实店铺数据且未被 `.gitignore` 覆盖；选择器与判据已全部提炼进本文）
- 弹窗夹具（脱敏，保留）：`python/lxeskill_cli/tests/amazon/fixtures/delivery_window_modal.html`（**3,113 字节**，单行；由 `.gitignore:85` 忽略，不入库）

**外部**

- Amazon 官方帮助「Send to Amazon：送达时段 - 采用标准日历周」（`sellercentral.amazon.com/help/hub/reference/external/G4ZKN4DCCXL5XQWJ`）——业务方于 2026-10-09 提供全文；**该页与同类 sellercentral 帮助页/论坛页用抓取工具只能拿到 HTTP 200 + 空正文（JS 渲染）**。
- 送达时段规则转述：`https://www.52by.com/article/196319`（2025-09-08）
- 2023 年首次强制与定义：`https://www.kuajingyan.com/article/27866`
- 「未接收」口径（第三方工具文档）：`https://www.revenuealot.com/zh/docs/amazon-inbound-shipments`
- 绩效影响与判定节点（自媒体）：`https://www.amz123.com/t/z9mUw5Mk`

**本机（2026-10-09 真机尝试留下的痕迹，只读引用）**

- 桌面端运行日志（首次）：`var/logs/runtime/20261006/{desktop.log,runtime.log,runtime-py.log}`（0 处紫鸟动作）
- 桌面端运行日志（第二次，2026-10-09 晚）：`var/logs/runtime/20261009/desktop.log`（439 行；3 次激活尝试全部失败在 `system_service_install`；云权限持续超时 —— 见 §14）
- 提权失败复现装置：`/tmp/lxe-wg-repro/main.cjs`（逐字重建 provisioner 的 AppleScript 提权命令；①② 两次实测结果见 §14.2）
- 手工安装用的 staging 副本：`/tmp/lxe-wg-capture/{service.sh,target/lxe-agent.conf}`（`service.sh` 与仓库模板 `cmp` 逐字节相同；配置 251 B，用脚本自带 `validate_config` 校验 rc=0）
- WireGuard 服务现场：`/Library/LaunchDaemons/com.lxe.wireguard.lxe-agent.plist`（`launchctl print system/com.lxe.wireguard.lxe-agent` = `state = running`）、`/Library/Application Support/LXE/WireGuard/`（当前账号无读权限，需 root 查看）
- 紫鸟客户端自身日志：`~/Library/Application Support/ziniaobrowser/logs/client/main.20261009.log`（`parsed cli startup arguments` 段是判断启动参数有没有送达的唯一可靠依据）
- 紫鸟客户端成功日志：`~/Library/Application Support/ziniaobrowser/logs/client/main.20261010.log`（`09:35:01` 普通 GUI 启动无 WebDriver 参数；`10:43:49` 完整收到 `--run_type=web_driver --ipc_type=http --port=16851`）
- 紫鸟调用顺序修复：`8318d246 fix: stop retrying Ziniao authentication as startup probe`；随合并提交 `c40452e5` 进入当前 `codex/fba-delivery-window` 分支
- 会话记录：`var/db/session_transcripts/`；另有 `var/db/agent.sqlite3`（agent 侧 DB，Python 侧不读写）

## 13. 真机验证记录（2026-10-09 首次尝试：历史记录，权限归因已被后续实测推翻）

**当日结论**：代码侧准备（模块、83 条单测、dry-run 闸门）已就绪；当时浏览器自动化链路停在紫鸟服务端鉴权 `-10003`。当日据官方排障表暂时怀疑账号侧权限，但该归因已被 2026-10-10 的成功实测推翻：同一套当前配置已完成 `updateCore → getBrowserList` 并返回 8 个店铺，详见 §15。

### 13.1 三次尝试与真实报错（逐字保留，未包装）

| 时间 | 动作 | 结果 |
| --- | --- | --- |
| 14:49 | 首次 `browser store --action get_status` | `statusCode: -10003`，`err: "参数不能为空（登录状态错误）"` |
| 15:50 | 客户端已人工登录 GUI，再跑一次 | 12 条 `driver exists and sha1 matched` → `old client process cleaned: ['killall','ziniao']` → `-10003`，`err: "错误次数太多，请10分钟后再试"` |
| 16:40 | 客户端已人工以 web_driver 模式监听 16851，再跑一次 | 探测（内部即 `getBrowserList`）仍失败 ⇒ 代码把客户端 killall 重启 ⇒ 再次 `-10003 / 错误次数太多`，`exit=4` |

16:40 的原始应答：

```
{"type":"result","command":"browser store --action get_status","ok":false,"data":{},"files":[],
 "error":{"code":"browser_action_failed",
   "message":"failed to load browser list: {'action': 'getBrowserList', 'requestId': '2389c3b5-9813-4ff2-9d80-e9852990954d', 'statusCode': -10003, 'err': '错误次数太多，请10分钟后再试'}"}}
```

**关键读法**：这是一份**结构完整的 JSON 应答** ⇒ 客户端确实以 `web_driver` 模式起来了、16851 的 HTTP 服务是通的；**失败的只是服务端鉴权那一步**。注意「客户端启动成功」与「接口鉴权通过」是两件事，探测失败会被代码当成前者，从而误触发一次 "killall 重启客户端"。

### 13.2 当时的归因（已被 §15 修正）

> 下面保留的是 2026-10-09 当时基于 `-10003` 作出的排查假设，不再代表当前结论。现在只能确认当时存在错误调用顺序和重复鉴权；不能再把 `-10003` 单独当成“未开通 WebDriver 权限”的证明。

- **主因（待人工确认）**：`-10003` 官方解释只有一条 —— 「登录失败（**需开通 webdriver 权限 / 关闭登录验证**）」（`reference/api-core.md:93`；排障表 `reference/prerequisites.md:124`：`getBrowserList 返回 -10003 → 未开通权限或未关闭登录验证 → 检查权限开通状态`）。
- **次因（反复重试喂出来的）**：`err` 的「错误次数太多」是服务端限流。凭据接口每次调用都必须带全 company/username/password（`SKILL.md:107`），每次都是一次登录尝试；连续重试只会续期这个窗口。
- **最容易搞混的一点**：**GUI 能登录 ≠ 接口能鉴权**。GUI 用客户端自己的登录态；接口是每次拿凭据去服务端重新校验、并另查 WebDriver 权限 —— 两条独立通道。所以「人在紫鸟客户端里能打开店铺、能操作页面」**不能**证明接口能通。
- **当时本机尚未成功过的旁证**：截至 2026-10-09，全仓（含所有 worktree）不存在 `local_agent.sqlite3`（真正附着过店铺才会生成）；桌面端只运行过一次（10-06 17:58–18:00，两分钟），日志里 `ziniao` / `getBrowserList` / `startBrowser` / `16851` 出现 **0 次**；那个反复报的 `browser_auth_service ... Mabang 账号为空` 是**马帮（另一平台）**的授权刷新，与紫鸟无关。

### 13.3 当时拟定的下一步（历史记录，已由 §15 取代）

1. 向紫鸟（企业管理员/客服）确认：企业账号 `黎永昕` / 深圳市雷袖尔科技有限公司**是否开通 WebDriver 权限**，并**关闭登录验证**。
   - 先看 **§13.7**：同事那份"能打开店铺"的脚本用的是**另一个账号 `美客多自动化`** —— 这极可能才是开通了 WebDriver 权限的账号，优先拿它的密码复跑。
2. 权限开通后**停手等限流窗口过去**，然后**只跑一次** `get_status` 定论；**不要连续重试**。
3. 通过后按 §8 的阶梯推进：L2 `plan_only` → L3 dry-run（`apply=False`）→ L4 `apply=True`，且**先只给一票**。

### 13.4 手动启动配方（本次唯一跑通的动作）

```
killall -9 ziniao
for i in $(seq 1 15); do sleep 1; pgrep -f 'MacOS/ziniao' >/dev/null || break; done
open -a /Applications/ziniao.app --args --run_type=web_driver --ipc_type=http --port=16851
sleep 8
lsof -nP -iTCP:16851 -sTCP:LISTEN
grep "parsed cli startup arguments" ~/Library/Application\ Support/ziniaobrowser/logs/client/main.$(date +%Y%m%d).log | tail -1
```

成功的样子：`16851` 有 LISTEN，且客户端日志 `startupArgv` 含 `--run_type=web_driver --ipc_type=http --port=16851`。

**判据（参数到底有没有送进去）**：只看客户端日志那段 `parsed cli startup arguments {...,"startupArgv":[...]}`；若只有 `--use-chromium-request`，就是**参数丢了** —— 此时 16851 不监听，表现为 `Connection refused`，而不是 `-10003`。这两种失败必须区分开。

### 13.5 顺带发现：`kill_process()` 疑似会让 `open` 丢参数（**本次不改**）

`python/lxeskill_cli/services/browser/store/ziniao_process.py:149-174 kill_process()` 在 macOS 只发 `killall ziniao`（SIGTERM）然后 `time.sleep(3)` 就启动。实测对比：

- 代码路径（SIGTERM + 3 秒）→ 客户端以普通 GUI 模式起来，`--args` 丢失，16851 不监听；
- 人工路径（`killall -9` + 轮询到进程数真的为 0）→ 参数完整送达。

⇒ 疑似「3 秒不够、客户端没退干净时 `open` 会丢弃 `--args`」。修法：SIGKILL + 轮询到 0 再启动。该文件是**共享模块**，按「一分支一任务」**不在本分支顺手改**，另开任务。

### 13.6 当时的链路缺口：`updateCore` 从未被调用（已修复）

官方流程要求「客户端启动后**必须首先调用 `updateCore`**（带凭据）」（`reference/prerequisites.md:115`；接口章节 `reference/api-auxiliary.md:189-218` 强调"这是最常见的对接错误之一"）。2026-10-10 已在 `8318d246 fix: stop retrying Ziniao authentication as startup probe` 中补齐：本地存活探测改用不带凭据的 `getRunningInfo`，认证请求前执行 `updateCore`，只对 `-10000`（处理中）按 2 秒轮询；`-10003` 等其它错误立即原样失败，不再重启客户端或重复鉴权。该提交随 `c40452e5` 合入当前 `codex/fba-delivery-window` 分支。

### 13.7 同事那份"能打开店铺"的脚本给出的关键线索（**账号不同**）

本机桌面另有一份**不经 LXE_Agent 体系**的独立脚本：`~/Desktop/紫鸟自动打开api/`（`README.md` 61 行 + `config.yaml` 21 行 + `ziniao_open_store.py` 447 行，照官方 WebDriver 接口手写；同事说它能登录、能打开店铺）。逐行对照后：**它没有做任何"登录"动作** —— 流程与 §13.1 完全一致：关残留进程 → `open -a <app> --args --run_type=web_driver --ipc_type=http --port=<port>` → 等端口就绪 → 调接口。登录是**客户端自身的登录态**完成的。

**两个实质差别**：

1. **账号不同（最可能的答案）**：`config.yaml` 里 `user_info.username: 美客多自动化` —— **不是 `黎永昕`**。WebDriver 权限很可能开在这个专用自动化账号上（该 `README.md` 也把"已在紫鸟开放平台开通 Webdriver 权限（联系紫鸟客服申请）"列为前置条件）。
2. **它先调 `updateCore`**（带凭据）再 `getBrowserList`（`ziniao_open_store.py:80-99` 实现、`:392-396` 调用）；当时本项目 Python 侧 0 处调用，现已按 §13.6 修复。它对 `updateCore` 返回 `-10003` 的处理是打印「当前版本不支持此接口，请升级客户端」后直接返回。

**其它差异（非关键，供参照）**：杀进程同样是 `pkill -x ziniao` + `time.sleep(3)`（`:188-196`，与 §13.5 的毛病同源 ⇒ 它不是靠"杀得更干净"取胜）；驱动走 CDN **直连**下载（`session.trust_env = False`，`:237-298`；配置地址 `https://cdn-superbrowser-attachment.ziniao.com/webdriver/mac/{arm64|x64}/config.json`）；店铺按 `browserName` **精确匹配**、匹配数 ≠ 1 直接报错（`:356-368`）；chromedriver 大版本取 `startBrowser` 返回的 `core_version`（`:330-353`）。

**注意**：那份脚本在本机**跑不起来** —— 它 `from runtime_config import mac_architecture` / `from runtime_secrets import require_secrets`，路径解析 `ROOT = MODULE_DIR/../..` = `~/`，而 `~/scripts/` 在本机不存在（`requirements.txt` 只有 requests / yaml / selenium）。它应是从同事机器拷来的、缺依赖；不影响本结论（我们取的是它的 config 与接口顺序）。

**后续结果**：无需切换到该同事账号；当前配置在 2026-10-10 已成功返回 8 个店铺。账号差异仍可作为历史排查线索，但不再是当前阻塞项。

## 14. 环境阻塞的解除记录（2026-10-09 晚：TCC 挡住提权 → 搬仓库 → 手工装服务）

**一句话**：真机验证卡住的第一层不是紫鸟账号，而是**开发版桌面端根本装不上 WireGuard 系统服务**；根因是 macOS 的隐私保护（TCC）不让提权后的 root 子进程读 `~/Desktop` 下的文件。把仓库从桌面搬到 `~/LXE_AGENT` 后这一层解除，隧道已通；但**云接入本身仍未落盘**（见 14.5）。

### 14.1 症状

点「激活」后界面报：

```
Error invoking remote method 'lxe:desktop:activate-cloud-enrollment':
Error: WireGuard 配置失败：Command failed: /usr/bin/osascript -e do shell script "…/service.sh' install …"
```

`var/logs/runtime/20261009/desktop.log` 里 3 次尝试（本地 17:25:39→43、17:33:50→57、17:36:05→11）事件序完全一致：

```
cloud_enrollment_activation_started → cloud_enrollment_decrypted → wireguard_provision_started
→ wireguard_provision_failed → cloud_device_activation_failed
```

三次都 `failed_stage=system_service_install`、`previous_removed=false`、`duration_ms=4258 / 7032 / 5860`。

stderr 拿不到 —— `apps/desktop/src/main/macos-wireguard-provisioner.ts:145-152 boundedDiagnostic()` 只保留 500 字符，抛给界面又 `.slice(0,700)`，所以只能自己复现。

### 14.2 根因：TCC 保护桌面目录

复现装置 `/tmp/lxe-wg-repro/main.cjs` 逐字重建 provisioner 的那条 AppleScript 提权命令并 spawn `osascript`。同一条命令、同一台机器，**只换 staging 所在目录**：

| # | staging 位置 | exit | elapsed | stderr |
| --- | --- | --- | --- | --- |
| ① | 桌面（`…/Desktop/LXE_AGENT/.worktrees/pool-1/var/config/.cloud-wireguard/repro-stage`） | 1 | 6122 ms | `0:469: execution error: /opt/homebrew/bin/bash: …/repro-stage/service.sh: Operation not permitted (126)` |
| ② | `/tmp`（同一份文件、同一条命令） | 0 | 21465 ms | 空（服务装成功） |

① 那次日志首行还有 `sandbox_extension_issue_file_to_process failed for …/dist/Electron.app: 1 (Operation not permitted)`，进程自报 `__CFBundleIdentifier = com.apple.Terminal`。

解释：`osascript → security_authtrampoline(root) → bash` 这条链**读不到桌面下的文件**，bash 直接以 **126** 退出 —— 连脚本第一行的 `[[ $EUID == 0 ]]` 都没走到，所以 `/Library/Application Support/LXE` 一直不存在（与 `previous_removed=false` 吻合）。

为什么开发版必踩：staging 根 = `join(dataRoot,"config",".cloud-wireguard")`（`apps/desktop/src/main/macos-wireguard-provisioner.ts:295`），而源码模式 `dataRoot = <repo>/var`（`apps/desktop/src/main/paths.ts:61`）⇒ **源码放在 `~/Desktop` 里，这一步永远过不去**。打包安装版数据目录在 `/Applications/...` 内，不受此保护，所以官方文档没提这个坑。

（补充排除项：Homebrew 依赖齐全；`service.sh` 与配置格式正确 —— 用脚本自带的 `validate_config` 校验抓到的配置 rc=0；且**没有任何 TS 代码会删除** `/Library/Application Support/LXE`。）

### 14.3 处置：搬仓库（已完成）

User said (m02730)："我直接mv 移动过去了 你进去把环境和worktree改一下"。本次已完成：

- `mv ~/Desktop/LXE_AGENT ~/LXE_AGENT`（同卷改名，秒级；用户执行）。
- worktree 元数据：`git worktree repair` 在旧路径下**静默无效**，改为直接改两处绝对路径 —— `.git/worktrees/pool-1/gitdir` 与 `.worktrees/pool-1/.git`。之后 `git worktree list` 两条路径均为新前缀。
- 运行时配置：`…/pool-1/var/config/settings.json` 的 `workspace_root` 前缀改为新路径。
- 重建 venv：主 checkout 与 worktree 各 `rm -rf .venv && uv sync`（`.venv/bin/*` 里写死了旧绝对路径）。
- 撤销 14.4 之前的临时绕过：删掉 `/tmp` 软链，`var/config/.cloud-wireguard` 恢复为真目录（mode 700）。

验证：`uv run pytest python/lxeskill_cli/tests/amazon/test_delivery_window_apply.py` = **83 passed**；旧路径残留只出现在 `var/` 下的运行时记录里（迁移 marker `var/migrations/default-workspace-artifacts-v1.json`、`var/db/agent.sqlite3` 的 `agent_workspaces` 旧行、transcript / log），不影响运行 —— 绑旧目录的旧会话会打不开，换新路径开新会话即可。

### 14.4 兜底动作：手工装服务（本次真正让隧道起来的操作）

失败后被 `finally rmSync` 删掉的 staging 文件，靠 0.1 s 轮询抄了一份，然后在副本上手工跑：

```
sudo /opt/homebrew/bin/bash ./service.sh install ./target/lxe-agent.conf '' ./service.sh
```

⇒ exit=0。现状：`launchctl print system/com.lxe.wireguard.lxe-agent` = `state = running`（plist 时间 17:43）；`curl http://10.88.0.1:8000/api/v1/agent-data/health` = **http=200**。

注意：应用激活流程**没有"已就绪就跳过"分支**（`macos-wireguard-provisioner.ts:203-213 provision()` → `replaceTunnel()` 每次重装），所以下次点激活会把这套服务再装一遍 —— 正常，不是故障。

### 14.5 重要：**云接入仍未完成**（与口头印象不一致，以落盘为准）

判据（代码）：激活成功 ⇒ `apps/desktop/src/main/config-store/cloud.ts:47-73 saveEnrollment()` 会把 `cloud.managed` 置 `true`，并连同 api_key / WireGuard 配置一起 commit。

实际（2026-10-09 18:26 落盘）`…/pool-1/var/config/settings.json`：

```json
"cloud": {"managed": false, "device_id": "", "device_name": "", "vpn_ip": "",
          "data_server_url": "", "tunnel_name": "lxe-agent", "switch_in_progress": false}
```

日志侧：`desktop.log` 全 439 行里只有 **3 次**激活尝试（最后一次 17:36，**都在搬仓库之前**）；应用 17:57:39 重启后到 18:27:25 退出为止**0 次激活尝试**，只有每 5–11 分钟一轮 `native_cloud_access_failed` + `cloud_skill_permission_failed`（`observed_error: "URLError: <urlopen error timed out>"`）。

⇒ 结论：**本机还没有真正完成云接入**（不管界面上看起来是什么）。核对方法（一行）：

```
python3 -c "import json;print(json.load(open('/Users/lxe-3/LXE_AGENT/.worktrees/pool-1/var/config/settings.json'))['cloud'])"
```

期望 `managed: True` 且 `device_id` / `data_server_url` 非空。**重开桌面端（新路径）再点一次「激活」**即可重试 —— 现在 TCC 这层已经没了。

附带未解问题：桌面端拉 device-context / 权限一直 `urlopen error timed out`（2026-10-06 未激活时也是同一现象）。激活后若仍超时，属**第二条独立阻塞**（数据服可达性），要单独查。

### 14.6 紫鸟终端测试的三条前置（都是踩过的坑）

1. `uv run` 必须在项目里跑（`pyproject.toml:23` 定义 `lxeskill = "lxeskill.cli:main"`）；在 `~` 下会报 `error: Failed to spawn: lxeskill / cause: No such file or directory (os error 2)`。正确首行：`cd /Users/lxe-3/LXE_AGENT/.worktrees/pool-1 || exit 1`。
2. `get_status` 只做 `getBrowserList`（列店铺），**不会启动浏览器**，所以看不到窗口是正常的；要看见窗口必须 `open_store`（`startBrowser`，`isHeadless` 默认 0 = 可见窗口）。
3. 凭据只有三条通道，且 Python 侧**只读环境变量**（`python/lxeskill_cli/services/browser/store/ziniao_config.py:16`，并且刻意不读 `.env`）：紫鸟客户端 GUI 的「记住密码30天」只管 GUI；桌面端设置页写 `var/config/secrets.bin`；终端要自己 `export ZINIAO_COMPANY / ZINIAO_USERNAME / ZINIAO_PASSWORD / ZINIAO_CLIENT_PATH / ZINIAO_WEBDRIVER_PATH / ZINIAO_BROWSER_VERSION`。

另：账号要一致 —— `var/config/settings.json` 里 `integrations.ziniao.username = 黎永昕`，而同事那份能打开店铺的脚本用的是 `美客多自动化`（见 §13.7）。

### 14.7 当时拟定的下一步（历史记录，已由 §15 取代）

1. 新路径重开桌面端 → 点「激活」→ 用 14.5 那行命令核对 `managed: true`。
2. 激活成功（权限快照到位）后，用 `美客多自动化` 账号**只跑一次** `get_status`（只跑一次，避免再喂限流）。
3. 通过后按 §8 的阶梯走：L2 `plan_only` → L3 dry-run（`apply=False`，只读）→ L4 真写一票。

> 2026-10-10 更新：紫鸟控制链路已经打通，以上第 2 项已经完成；真实测试从 §15 的闸门继续。云接入状态与紫鸟本地控制链路是两件事，不再把 `cloud.managed` 当作判断 16851 / WebDriver 是否可用的依据。

## 15. 紫鸟链路打通与下一轮真实测试计划（2026-10-10）

### 15.1 已拿到的真实证据

本节只记录已经发生的结果，不用推测替代事实：

1. 紫鸟客户端日志 `~/Library/Application Support/ziniaobrowser/logs/client/main.20261010.log` 显示：
   - `09:35:01` 的普通 GUI 启动只有 `--use-chromium-request`，没有 WebDriver 参数；该状态不会监听 16851。
   - `10:43:49` 的启动参数完整包含 `--run_type=web_driver --ipc_type=http --port=16851`，随后客户端执行 GUI relaunch 时继续携带同一组参数。
2. 本机现场 `lsof -nP -iTCP:16851 -sTCP:LISTEN` 已看到 `ziniao` 在 `127.0.0.1:16851` 监听。
3. `lxeskill browser store --action get_status` 已成功返回：
   - `client_running: true`
   - 运行中店铺 0 个
   - 未启动店铺 8 个
4. 因此已经验证的链路是：

   ```text
   Electron 注入紫鸟配置
   → open -a /Applications/ziniao.app --args --run_type=web_driver --ipc_type=http --port=16851
   → getRunningInfo（无凭据，只做本地存活探测）
   → updateCore（带凭据）
   → getBrowserList（带凭据）
   → 成功返回 8 个店铺
   ```

5. 当前 `ZINIAO_CLIENT_PATH=/Applications/ziniao.app/Contents/MacOS/ziniao` 会由 `_resolve_macos_open_target()` 向上解析为 `/Applications/ziniao.app`。所以把 `.app` 改成内部可执行文件路径不是“获得权限”的原因；这次成功来自客户端真正收到 WebDriver 参数，以及修复后的探测和认证顺序。

### 15.2 尚未验证的边界

成功列出店铺只证明“本地控制端口 + 紫鸟认证”已经可用，**还没有证明以下环节**：

- ~~`startBrowser` 能否启动指定店铺并返回 `debuggingPort` / `core_version`。~~ 已验证：目标店铺启动成功，`debugging_port=11488`、`core_version=138.1.2.80`。
- ~~项目能否按 `core_version` 选中官方配对 chromedriver，并由 `SeleniumRunner` 成功附着。~~ 已验证：官方配对链路成功附着。
- ~~目标店铺的 Amazon 登录态是否仍有效。~~ 已验证：可读取 `sellercentral.amazon.com`，并进入“管理货件”列表。
- ~~目标货件详情页、STA 链接和追踪分页是否与现有选择器一致。~~ 已验证。
- ~~dry-run 能否读取当前时段、截止时间并安全关闭弹窗。~~ 已验证。
- ~~日历格子、翻月控件和确认按钮的运行时行为。~~ 已验证本次同月选择、日期点击和确认按钮；跨月翻页仍由 E7 失败关闭保护，尚无真实跨月样本。
- ~~`apply=true` 后是否能从页面回读到准确的新时段。~~ 已验证，见 §15.14。

### 15.3 首次真实测试闸门（已完成）

按下面顺序逐级推进；上一层没有拿到明确成功结果，就不进入下一层。**不自动重试、不并行开多个店铺、不批量处理货件。**

| 级别 | 动作 | 是否写 Amazon | 成功判据 | 失败时 |
| --- | --- | --- | --- | --- |
| R0 | 选定 1 个目标店铺，执行一次 `open_store` | 否 | 返回指定店铺、`core_version`、`debuggingPort` 等真实启动信息 | 原样记录错误并停止，不重复 `get_status` |
| R1 | 通过项目的官方配对 Selenium 附着并做一次只读页面快照 | 否 | 能读到 Amazon 页面 URL / title；若落在登录页，交给人工登录后再继续 | 不用 Playwright、Puppeteer 或裸 CDP 绕过 |
| R2 | `plan_only=true` 校验参数 | 否，且不接触页面 | 返回目标周、标准化后的 FBA 号与参数计划 | 修正输入后再进入 R3 |
| R2.5 | `action=discover` 动态发现工作流程子货件 | 否；只切换追踪详情分页 | 返回实际分页数量、每个完整 FBA 号、当前时段、截止时间和 `editable/locked/unavailable/unknown`；明确显示未打开弹窗 | 任一分页不能唯一识别时停止写入计划；不把 `unknown` 当成可修改 |
| R3 | 单票 `apply=false` dry-run | 否；允许打开编辑弹窗，随后尽力取消 | 返回货件号、当前时段、目标时段、可编辑截止；明确显示未点日历、未点确认 | 任一 E1–E9 立即停止，保留实际页面读数 |
| R4 | 人工核对 R3 的四项结果，并明确批准该票写入 | 否 | 人、店铺、FBA 号、目标日期四者再次一致 | 未明确批准就不执行 R5 |
| R5 | 同一票执行一次 `apply=true` | **是** | 确认按钮可用；提交后页面回读时段等于目标周；产物记录实际回读值 | 不自动补点、不换票；原样报告失败和页面实际值 |

### 15.4 开始前需要锁定的输入

下一轮开始前由业务方提供并再次确认以下 4 项：

1. **目标店铺**：从已经返回的 8 个店铺中选 1 个，店铺名或 `store_id` 均可。
2. **`page_url`**：该站点平常使用的 Amazon「货件一览」绝对 URL。
3. **`shipment_id`**：只给 1 个待测试的 FBA 货件号；第一轮禁止多票。
4. **`target_date`**：业务目标日期；程序会换算为周日到周六的目标周，但 R3 必须先把换算结果展示给人工核对。

### 15.5 当前执行边界

- R0–R5 已通过：目标店铺已启动、官方配对 Selenium 已附着、参数计划与 dry-run 已生成、人工批准后完成单票真实提交，页面回读与目标周一致。
- 首次 R3 在列表页被旧 E1 误拦截；修正后第二次只读测试到达 STA 工作流程，但因「最后一步：追踪详情」折叠而停在 E2。精确展开和动态 discovery 已补齐，并用 `FBA19QP2RBT8` 完成 5 个分页的真实 discovery；随后另选状态为“已发货”的 `FBA19SFNPGX1` 完成单票 dry-run 与真实写入（见 §15.14）。
- `delivery_window_list.py` / `delivery_window_apply.py` 已注册到 `catalog.json`，并由 `skills/fba-shipment-delivery-window/SKILL.md` 约束正式 Agent 流程；加载新 catalog/skill 需要重启 LXE Agent 后台组件或桌面端。
- 在单票 `apply=false` dry-run 成功并由人工核对前，绝不执行 `apply=true`。

### 15.6 首次 R3 暴露的 E1 误判与修正（2026-10-10）

- 输入：店铺 `Amazon-LEIXIUER-US`、货件 `FBA19QP2RBT8`、目标日 `2026-10-15`（目标周 `2026-10-11`–`2026-10-17`）、`apply=false`。
- 真实列表行：`orderStatus="正在接收"`、`unitStatus="516/516"`、当前送达时段 `2026-10-04`–`2026-10-10`。
- 旧结果：代码仅读取 `unitStatus`，据 `516/516` 在 E1 报“已经接收完成”，没有进入货件详情。
- 根因：把库存“已入库 / 预计上架”数量进度错当成货件生命周期；真实 DOM 的生命周期列是 `orderStatus`。
- 修正：E1 改为确认行存在并读取 `orderStatus`；`unitStatus` 只保留为诊断。最终可编辑性继续由 E3/E4 的 grace 文案、编辑入口与弹窗决定。
- 回归测试：新增 `orderStatus=正在接收 + unitStatus=602/602` 仍进入追踪详情，以及 `orderStatus` 缺失才在 E1 停止；定向结果 **84 passed**。
- 安全边界：修正后未自动重跑真实 R3；仍禁止点击日历、翻月和“确认新的送达时段”。

### 15.7 STA 折叠步骤与动态子货件发现（2026-10-10）

- 真实页面显示同一个 STA 工作流程的「目的地：5」，最终追踪步骤下有 5 个独立 FBA 子货件分页；5 是这次页面事实，不是固定数量。
- 直接打开 `/fba/sendtoamazon?wf=...` 时，追踪详情可能仍折叠。页面有多个同名 `data-testid="step-view-link"`，必须选最近祖先同时包含「最后一步」和「追踪详情」的链接，不能按索引盲点。
- 新增 `action=discover`：以用户提供的一个 FBA 号作为种子，动态枚举全部分页，逐页验证选中标记并只读当前时段、grace 和编辑入口；不打开编辑弹窗，不碰日历和确认按钮。
- 对话层把 discovery 结果展示给用户，接受自然语言选择；在真正写入前回显完整 FBA 号与目标日期，并只确认一次。
- 回归测试覆盖折叠展开、动态 3 分页、可编辑/锁定/无入口、发现参数和入口分发；当前定向结果 **96 passed**。

### 15.8 真实动态 discovery 结果（2026-10-10）

- 首次运行成功枚举 5 个分页，但全部误报 `当前送达时段无法读取（missing）`。真实 DOM 显示 Amazon 把标签和值放在同一个文本节点：`送达时段: 2026年10月4日 - 2026年10月10日`；旧解析器只支持标签和值分离。追踪区域还存在“分页先出现、详情稍后加载”的短暂状态。
- 修正：兼容 `标签: 值` 同节点，并在追踪分页出现后等待当前时段与 grace 文案就绪。用户实际打开第一个编辑弹窗证明 tooltip 中“无法再编辑”的文字不是链接禁用状态；tooltip 仅保留为诊断，硬禁用只认链接的 `disabled/aria-disabled=true`。
- 另一个根因是旧逻辑把 `not-selected` 拆词后误命中 `selected`，导致 5 个分页都被当作选中并重复读取第一个分页。现改为精确 class 匹配，并强制验证切换后只有目标分页为 `selected`；无法唯一确认时停止。定向结果 **96 passed**。
- 最终真实重跑：工作流程 `wf9b69e020-9688-4560-b668-0f7dc431af0c` 共 5 个子货件，`FBA19QP2RBT8`、`FBA19QP60G99`、`FBA19QPC6XSM`、`FBA19QP5R398`、`FBA19QP8GW5S` 均为 `editable`，可修改 5 个、未知项 0 个；每个分页都留有独立的唯一选中证据。
- 5 个子货件当前时段均为 `2026-10-04`–`2026-10-10`，页面 grace 截止均为 `2026-10-11T00:00:00+00:00`，编辑链接均存在且没有禁用属性。tooltip 文案仍记录在结果中，但不再覆盖真实链接状态。
- 最终证据文件：`.lxeagent/artifacts/browser/workflows/fba-delivery-window-discover-20261010/amazon-delivery-window-discover-1791614552.json`。本次 discovery 未打开编辑弹窗、未点击日历、未点击“确认新的送达时段”。

### 15.9 货件编号 2 的真实 `apply=false` 测试（2026-10-10）

- 输入：`FBA19QP60G99`，目标日期 `2026-10-15`，目标周 `2026-10-11`–`2026-10-17`，`apply=false`。
- 结果：`success=true`、`finished=true`、`status=dry_run_ready`。列表页状态为“正在接收”，分页唯一确认 `index=1`。
- 编辑弹窗成功打开；页面与弹窗中的当前送达时段交叉校验一致，均为 `2026-10-04`–`2026-10-10`。
- dry-run 最后成功点击“取消”。没有点击日历日期，也没有点击“确认新的送达时段”，Amazon 数据未改变。
- 证据文件：`.lxeagent/artifacts/browser/workflows/fba-delivery-window-dry-run-20261010/amazon-delivery-window-apply-1791614764.json`。

### 15.10 修改后能否恢复原时段（2026-10-10）

- Amazon 官方论坛员工引用帮助页 FAQ 的口径：送达时段只能修改到“当前时段开始日”与“货件实际送达日”两者中较早者；当前时段开始后原则上不能再修改。
- 对 `FBA19QP60G99` 的真实日历做了只读探针：原时段 `2026-10-04`–`2026-10-10` 的 7 个日期全部为 `aria-disabled=true`，对应单元格 class 均包含 `disabled`；目标时段 `2026-10-11`–`2026-10-17` 的日期均为 `aria-disabled=false`。
- 结论：现在可以从旧周改到目标周，但修改后无法保证再选回已经开始的旧周。因此不执行“真实修改后再回改”，避免留下不可恢复的 Amazon 数据变更。
- 探针只打开弹窗并读取日历属性，随后成功点击“取消”并确认弹窗关闭；未点击日期、未点击“确认新的送达时段”。

### 15.11 增强 dry-run：选择目标日期后取消（2026-10-10）

- 输入：`FBA19QP60G99`，目标日期 `2026-10-15`，目标周 `2026-10-11`–`2026-10-17`。
- 正确选中 `index=1` 后打开编辑弹窗，页面与弹窗的修改前时段均为 `2026-10-04`–`2026-10-10`。
- 成功点击 `2026-10-15`；图例“已选择”准确更新为 `2026-10-11`–`2026-10-17`，确认按钮存在且 `disabled=false`。
- 没有点击“确认新的送达时段”；成功点击“取消”并确认弹窗关闭。取消后页面回读仍为 `2026-10-04`–`2026-10-10`，Amazon 数据未改变。
- 结论：除最终确认提交与提交后的服务器回读外，当前真实页面写路径已经全部验证。

### 15.12 按业务状态收紧 E1（2026-10-10）

- 销售部门确认：修改日期依据列表前部的货件生命周期状态，不依据后部的 `0/172` 等入库数量；正式业务一般只允许 `已发货`。
- 代码把“读取状态”和“允许修改”拆开：`apply` 仅接受 `orderStatus="已发货"`；`正在接收`、`已完成`、`在途`等状态在打开货件详情前以 E1 停止。
- `discover` 仍可用一个种子编号定位并动态枚举整个 STA 工作流程，但逐个回查列表状态：`已发货` 才继续检查时段与编辑入口；`正在接收` 等返回 `status="ineligible"`、`editable=false`，不切换其分页；列表缺行或状态不可读则返回未知。
- `unitStatus` 保持纯诊断：新增回归证明 `已发货 + 0/172` 可以继续，而 `正在接收 + 0/172`、`已完成`、`在途`均会停止。
- 定向测试：`uv run pytest python/lxeskill_cli/tests/amazon/test_delivery_window_apply.py -q`，结果 **101 passed**。本轮仅更新代码、测试和文档，没有连接店铺或执行 Amazon 页面操作。

### 15.13 下一轮实际修改测试：必须先附着浏览器（2026-10-10）

本节是下一次真实 `apply=true` 测试的执行清单。**“紫鸟店铺窗口已经打开”不等于脚本已经附着浏览器**；正式运行前必须执行下面的 `browser_snapshot` 命令，确认项目能够通过当前 Agent 会话找到店铺会话，并使用官方配对的 `SeleniumRunner + chromedriver` 附着。禁止改用 Playwright、Puppeteer、系统 ChromeDriver 或裸 CDP。

#### A. 先锁定变量

以下 5 项必须使用当次真实值，不得沿用旧店铺或猜测：

```bash
cd /Users/lxe-3/LXE_AGENT/.worktrees/pool-1 || exit 1

export LXE_AGENT_SESSION_ID="<当前 LXE_Agent 会话 ID>"
export LXE_FBA_STORE_ID="<Amazon-Yunjian-US 对应的 store_id>"
export LXE_FBA_PAGE_URL="https://sellercentral.amazon.com/manage/shipments?ref=sc_shipments"
export LXE_FBA_SHIPMENT_ID="<本次选定且列表状态为“已发货”的完整 FBA 号>"
export LXE_FBA_TARGET_DATE="<YYYY-MM-DD>"
```

- `store_id` 必须来自当次 `get_status`，不能仅凭店铺名称构造。
- `shipment_id` 必须逐字匹配列表中的完整 FBA 号，且 `orderStatus` 必须为 `已发货`。
- `target_date` 由业务方提供；脚本计算出的周日到周六目标周必须在写入前再次回显确认。

#### B. 确认店铺运行状态；仅在未运行时启动

```bash
UV_CACHE_DIR=/tmp/lxe-uv-cache uv run --frozen lxeskill browser store \
  --session-id "$LXE_AGENT_SESSION_ID" \
  --action get_status
```

如果 `Amazon-Yunjian-US` 已在运行，直接复用，**不要再次 `open_store`**。只有未运行时才执行一次：

```bash
UV_CACHE_DIR=/tmp/lxe-uv-cache uv run --frozen lxeskill browser store \
  --session-id "$LXE_AGENT_SESSION_ID" \
  --action open_store \
  --store-id "$LXE_FBA_STORE_ID"
```

#### C. 必须执行的“附着浏览器”命令

```bash
UV_CACHE_DIR=/tmp/lxe-uv-cache uv run --frozen lxeskill browser page \
  --session-id "$LXE_AGENT_SESSION_ID" \
  --action browser_snapshot \
  --store-id "$LXE_FBA_STORE_ID"
```

成功判据：命令 `ok=true`，并返回当前 Amazon 页面 URL / title / snapshot 内容。该命令内部按 `store_id` 读取运行中的紫鸟会话，取得 `debugging_port`、`core_version` 和 `browser_path`，再由项目的 `SeleniumRunner` 选择匹配的 chromedriver 并附着；**不得手工填写调试端口，也不得直接启动另一个浏览器**。如果这里失败，原样记录实际错误并停止，不运行后面的改期命令。

#### D. 先做同参数 dry-run

> 本节保留的是正式注册前的首次真实写入执行清单。当时 `delivery_window_apply.py` 尚未注册到 `catalog.json`，所以使用下面的受控开发入口；注册完成后的 Agent 必须改用 §15.14 的 canonical `lxeskill` 命令，禁止直接执行 Python 模块。

```bash
UV_CACHE_DIR=/tmp/lxe-uv-cache uv run --frozen python -c '
import json
import os
from services.agent_cli.browser.amazon_fba import delivery_window_apply as command

result = command.run({
    "action": "apply",
    "store_id": os.environ["LXE_FBA_STORE_ID"],
    "page_url": os.environ["LXE_FBA_PAGE_URL"],
    "shipment_ids": [os.environ["LXE_FBA_SHIPMENT_ID"]],
    "target_date": os.environ["LXE_FBA_TARGET_DATE"],
    "apply": False,
})
print(json.dumps(result, ensure_ascii=False, indent=2))
'
```

只有以下结果全部成立才能准备真写：

1. E1 回读 `order_status="已发货"`；`unitStatus` 数量只记录、不参与放行。
2. 完整 FBA 号、当前送达时段、目标日期和目标周与人工确认一致。
3. 编辑弹窗能打开并安全取消，结果为 `dry_run_ready`；没有点击“确认新的送达时段”。
4. 当次操作者再次明确批准这一个店铺、一个 FBA 号和一个目标日期的真实写入。

#### E. 实际修改命令（有写操作，只执行一次）

得到 D 步之后的明确人工批准，才允许把同一份参数的 `apply` 改成 `True`：

```bash
UV_CACHE_DIR=/tmp/lxe-uv-cache uv run --frozen python -c '
import json
import os
from services.agent_cli.browser.amazon_fba import delivery_window_apply as command

result = command.run({
    "action": "apply",
    "store_id": os.environ["LXE_FBA_STORE_ID"],
    "page_url": os.environ["LXE_FBA_PAGE_URL"],
    "shipment_ids": [os.environ["LXE_FBA_SHIPMENT_ID"]],
    "target_date": os.environ["LXE_FBA_TARGET_DATE"],
    "apply": True,
})
print(json.dumps(result, ensure_ascii=False, indent=2))
'
```

真实写入的成功判据不是“点击没有报错”，而是返回 `status="applied"`，并且 E8 从页面回读到的 `applied_window` 精确等于目标周。若失败，不自动重试、不换另一票、不补点确认按钮；保留实际响应与证据文件后停止。

### 15.14 首次真实写入与正式 Agent 注册（2026-10-10）

- 真实输入：店铺 `Amazon-Yunjian-US 深圳市久艺电子商务有限公司`（`store_id=VycOXC1cvUBC/rBIOnYXUg==`）、货件 `FBA19SFNPGX1`、目标日期 `2026-11-16`。
- 写入前 dry-run：列表状态 `orderStatus="已发货"`、`unitStatus="0/172"`；当前时段 `2026-11-08`–`2026-11-14`，目标周 `2026-11-15`–`2026-11-21`，弹窗交叉校验一致并成功取消，未点日历或确认按钮。
- 人工明确批准后只执行一次 `apply=true`：目标日点击成功，图例“已选择”精确显示目标周，确认按钮存在且可用。
- 最终结果：`status="applied"`，E8 从页面直属文本回读 `applied_window=2026-11-15`–`2026-11-21`，无 `failure_code` / `failure_detail`；未修改同工作流程中的其它货件。
- 证据：`.lxeagent/artifacts/browser/workflows/fba-delivery-window-yunjian-20261010/amazon-delivery-window-apply-1791619589.json`。
- 正式命令：
  - `lxeskill fba shipment delivery-window-list`
  - `lxeskill fba shipment delivery-window`
- 正式 skill：`skills/fba-shipment-delivery-window/SKILL.md`。它固化“真实店铺附着 → plan-only → dry-run → 回显人工批准 → 同参数单次 apply → E8 页面回读”的写入闸门，并明确禁止直接 Python 入口和非 Selenium 页面自动化。

### 15.15 正式列表命令的首轮 Agent 回归与修复（2026-10-10）

首次通过 LXE Agent 调用 `delivery-window-list` 时，浏览器快照已经显示 Amazon「管理货件」页，但命令在 `driver.get(page_url)` 后立即读取 React/SPA 表格，货件行尚未渲染便返回 0 行。错误文案又包含“登录态失效”，被 CLI 的通用关键字恢复逻辑误判成马帮认证故障，因而错误建议执行 `lxeskill auth refresh`；随后出现的“Mabang 账号为空”与 Amazon 会话无关。

修复约束：

- 列表命令导航后轮询语义选择器，默认等待 60 秒，允许通过 `--timeout-sec 1..600` 调整；只有超时后仍为 0 行才失败。
- 列表与改期命令的返回结构都显式设置 `auth_refresh_required=false`，阻止 CLI 为 Amazon/紫鸟工作流推荐马帮认证恢复。
- 0 行错误只陈述已经观测到的事实和未确认的可能性，不再把登录失效写成既定诊断。
- 回归测试覆盖“首读为空、随后 SPA 行出现”以及“失败结果不包含 auth refresh 恢复命令”。
- 修复后的 canonical `plan_only` 已验证能接收 `--timeout-sec 60`。真实只读复测时目标店铺仍报告运行中，但 Selenium 附着只看到 `about:blank`，因此在导航前按真实错误停止；该结果已正确带 `auth_refresh_required=false` 且没有马帮恢复命令。需在紫鸟窗口恢复正常 Amazon 标签页后再做页面级复测，不能把这次外部状态阻塞写成“实页验证通过”。
