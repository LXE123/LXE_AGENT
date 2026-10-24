---
name: fba-logistics-query
description: 选择已配置物流账号，通过统一入口查询 FBA；威飒和天泰已有用户回传登录证据，云驼已登录工作台、查询页续验待完成，飞沃可直接查询、不要求先登录，九方走独立匿名查询。天泰与九方识别已确认的 U+6位数字箱号后缀；取得运单和尾程转单号后衔接 UPS/FedEx，货代日期不作为改期依据。
type: ziniao_browser
commands:
  - lxeskill logistics profiles
  - lxeskill logistics login
  - lxeskill logistics query
  - lxeskill logistics wesa query
  - lxeskill logistics feiwo query
  - lxeskill logistics yuntuo query
  - lxeskill logistics tiantai query
---

# FBA 物流商查询

## 交互门槛：整条只读链最多一次登录确认

用户提出按 FBA 查询物流并取得送达依据时，视为已经授权本次完整只读链：选择已明确的物流配置、查询物流商、取得全部尾程承运人和转单号、进入对应 UPS/FedEx 等官方追踪页、输入单号、读取状态与日期并形成结果。不得在物流商查询、尾程跳转、尾程搜索、页面读取或返回 Amazon 之间逐步询问“是否继续”。这些动作不修改物流订单、原表或 Amazon。

整个业务流程最多有两个确认点，其中本技能只负责第一个：

1. **登录确认**：只有确实需要提交已保存的物流账号凭据，或多个配置无法从用户已给信息唯一确定时，集中展示物流商、配置名称及目标浏览器环境并确认一次。该确认同时授权登录成功后继续完成物流商及尾程只读查询，不再追加查询确认或跳转确认。已有登录态且账号、环境均已明确时直接继续，不制造形式确认。
2. **修改确认**：属于 `fba-shipment-delivery-window`。只有完整只读证据、建议和 Amazon dry-run 已准备好，才一次性请求是否执行真实修改。

验证码、账号不符、FBA 身份冲突、转单号关系不完整或官方追踪无法读取属于阻断结果，应停止受影响货件并报告实际证据；不要把故障处理包装成反复确认。缺少必需输入时一次性询问缺失信息，这属于补充数据，不是新增审批门槛。

## 配置账号与统一入口

优先使用 `lxeskill logistics profiles [--provider wesa]` 取得当前配置的精确 ID、名称、物流商、启用状态及登录账号。名称不唯一或用户未明确账户时，把账户选择合并到一次登录确认中，不枚举账户碰运气。停用配置不能查询。配置跨店铺复用，浏览器环境由本次任务指定；物流环境不证明 Amazon 货件归属。

```text
lxeskill logistics profiles --provider wesa
lxeskill logistics query --profile-id <UUID> --store-id <运行中的环境ID> --fba <完整FBA> --account-name '<本次页面确认的公司全名>'
```

统一入口只查一票，返回 `profile_id/provider/settings_revision` 和完整适配器 `result`。同时检查顶层 `ok`、`data.success` 及 `data.result`；不得丢弃原有 warnings、missing_fields、分页及错误。按当前技能范围逐物流商检查权限，九方技能不能借统一入口操作浏览器。

威飒/天泰配置已保存凭据时，默认先检查登录；也可单独执行 `lxeskill logistics login --profile-id <UUID> --store-id <运行中的环境ID>`。密码由 Desktop 内部解密，经私有子进程 stdin 交给配对 Selenium，不向模型、CLI 参数、环境、公共配置或返回对象暴露。需要重启加载本分支的 Desktop 才有内部登录服务。不要在聊天或命令中填写密码，不调用马帮 `auth refresh`。

登录仅附着已有的唯一供应商域名，不启动/重启店铺、不替换其他标签页、不自动退出或切换账号。登录页必须有唯一、可见的账号/密码表单及明确登录按钮，表单目标须同源；有验证码、结构歧义、跨源、超时或真实失败即停，不重试。通用实时表单校验的本地测试使用合成 DOM；后续威飒已有用户回传真实凭据登录及统一查询成功摘要，天泰实页登录仍待验收。现场表单不符合时返回实际证据，不猜选择器或接口。

`authenticated` 只表示读到受控的已登录控制台特征；`login_attempted` 表示本次是否提交了登录；`configured_login_submitted=true` 表示本次提交配置中的凭据并读到控制台。当前表单证据尚不能权威核验登录用户名，`profile_identity_verified=false`，不能宣称当前公司属于所选配置。无论新登录还是 `status=already_authenticated`，先用真实快照核对公司，再传 `--account-name` 明确查询；公司候选只作诊断，不使用旧配置公司名或登录账号代替，也不自动退出当前账号。

`--login-mode reuse` 可明确只复用当前登录态；不改变查询的 origin、账户可见性、完整 FBA 检查。云驼已按真实登录页证据接入固定表单，实页提交仍待验收；飞沃统一入口使用原有查询页，可直接查询，不要求先登录或先调用 `logistics login`，不列自动登录待办。九方匿名统一查询见独立技能。自动登录不查询尾程 ETA，也不修改物流订单或 Amazon。

2026-10-21 用户回传：威飒实际提交配置凭据并进入控制台，随后本次快照确认“深圳市新棱镜贸易有限公司”，再以同一配置、`--login-mode reuse` 统一查询 `FBA19SS5YN6R`，于 `03:40:51Z` 精确命中 `WS10027586 / SMF3 / UPS / 1ZH910550314112374`，HTTP/业务成功、分页完整、仓库一致、无 warnings/missing_fields。证据为用户摘要，不是已归档的完整 terminal JSON 或登录表单 fixture；不扩大为默认 auto 单命令新登录、其他账户、天泰或验证码场景通过。本票无需重复同阶段验收。后续 UPS 页面仅取得部分状态文本；文本截断时，未取得 ETA 不等于已经确认完整页面无 ETA，也不阻断已满足条件的业务顺延建议。

## 在送达时段流程中的职责

本技能负责建立“完整 FBA → 物流商运单 → 尾程承运人及转单号”的对应关系。威飒、飞沃、云驼和天泰是此处的物流商；UPS/FedEx 等实际尾程承运商提供送达状态及预计日期。

若整体任务包含 Amazon 改期建议或修改，先由 `fba-shipment-delivery-window` 完成当前目标 Amazon 店铺的只读 discovery，精确确认完整 FBA 后再进入本技能。沿用已确认的所属店铺和货件映射，不重复读取；物流账号配置无需绑定店铺，本技能的 `store_id` 仅用于附着物流页面，不能推断 Amazon 货件归属。独立物流查询不要求 Amazon 前置校验。

- 查询后建议改期时，取得明确的尾程承运人和转单号后，继续核验对应 UPS/FedEx 等官方追踪结果。货代后台的下单、到港、清关日期、转述轨迹或状态不能替代这一步。
- 物流商查询成功并取得明确尾程单号后立即继续官方追踪，不向用户回报半成品后等待“查询确认”或“跳转确认”。批量任务先保留逐票映射，再查询全部明确的尾程单号；每个单号分别记录官方结果，不能用第一票代表整批。
- 物流商结果没有 ETA，或 `missing_fields` 包含 `eta`，不妨碍使用已核实的承运人和转单号进入尾程查询。保留缺项诊断，不要求物流商先提供日期；承运人或转单号缺失、身份/目的仓冲突则暂停对应项。
- `request_succeeded/found/complete` 只说明本次物流商查询结果，不证明 UPS 已收件、已送达或 Amazon 已接收。
- 查询后建议的日期来源、无预计日期时的处理及证据要求，见 [尾程证据与改期建议](../fba-shipment-delivery-window/references/carrier-evidence.md)。单独查询物流商的请求仍只报告查询结果，不自行进入 Amazon 修改。

## 威飒单票查询

九方通逊使用独立技能 `jiufang-logistics-query` 和命令 `lxeskill logistics jiufang query`，已验证公开接口可匿名查询，不需要物流账号或紫鸟店铺；支持对已知箱号后缀拆分并精确核对返回的主号。不能把官网顶部搜索框的登录限制套用到公开接口。本技能下的威飒、飞沃和云驼仍沿用各自的浏览器查询约束。

通过 `exec` 独立调用 canonical CLI。在 LXE_Agent 真实会话中，复用已运行紫鸟店铺和威飒登录态。按 `ziniao-browser` 技能先 `get_status`，核对指定店铺运行，再使用 `--strict-attach --target-host wsaexp.nextsls.com` 快照核对唯一威飒标签页及当前公司账户。`account_name` 使用本次快照实际显示的完整公司名，不能照抄历史账户。

```text
lxeskill logistics wesa query --store-id <store_id> --account-name '<公司账户全名>' --fba <完整FBA> --expected-warehouse <目的仓>
```

命令固定通过官方配对 Selenium，在 `http://wsaexp.nextsls.com` 原页面上下文 POST `/rest/tms/wos/shipment/lists`。内置严格附着，不接受 URL、脚本、密码或 Cookie 参数。默认使用已核实的“全部”完整请求；`--query-mode delivered` 则使用独立抓取的“已签收”请求。

读取 terminal 顶层 `ok` 和 `data`：

- `request_succeeded` 表示 HTTP、业务状态、列表形状和分页检查通过；`found` 表示本页存在完整 FBA 精确匹配，不能混为一谈。
- `matches` 保留全部匹配行、原文、承运人和多个转单号。`missing_fields`、`warnings` 和 `warehouse_matches` 必须报告；不得用第一个结果代替整票，也不能根据号码格式推断承运人。
- `parcel_count` 已观察到 HTML 字符串和非负整数两种形状：字符串输出可读文本，数字保留原整数；`source_html` 保留原字段值。件数不是日期或包裹单号覆盖完整的证明。
- 命令每次只读一页；`complete=false` 时由代理依据已返回的 `pagination.total/pageSize` 自动继续明确的后续页，不逐页询问用户。分页值不一致、超出命令上限或响应截断时停止并报告，不能把本页零匹配说成整票未找到，也不能无边界枚举未知范围。
- `returned_active_tab` 与 `all_tab_confirmed` 只证明响应页签读数；跨状态覆盖仍需已知在途样本验证。
- `account_visible=true` 只表示指定公司全名存在于当前可见文本，不能替代上一步对当前公司账户的人工/页面核对，也不证明长期账户归属。
- `queried_at` 为本次 UTC 查询时间。列表不包含已经核实的 ETA/实际签收时间，不用下单时间或页签代替。

失败时保留并转述脱敏后的实际 `data.error` 和 HTTP/业务诊断。登录失效、验证或结构异常时停止，交由用户恢复；不执行马帮 `auth refresh`，不自动重试、重启或切换账户。桌面物流商配置保存登录账号和加密密码，不再要求填写公司名称。查询需要的 `account_name` 从本次实际页面核对取得，不能使用登录账号或旧配置中的公司名代替。独立供应商命令继续遵守各自的浏览器查询约束；需要登录的供应商由上述统一入口或 `logistics login` 检查，不能把凭据保存当作登录已通过。飞沃直接查询，无需登录凭据或登录检查。

查询不授权修改订单、原表或 Amazon；后续改期自动衔接专用 Amazon 技能的建议和 dry-run，只在真实写入前请求一次修改确认。

# 天泰供应链单票查询

在 LXE_Agent 真实会话中先检查店铺状态，再附着天泰页面并核对公司账户全名。天泰有两个公司账户，必须分别记录本次账号、浏览器环境和页面映射；物流账号不固定绑定店铺。不能因网址相同而把它们视为同一账户。

```text
lxeskill browser page --action browser_snapshot --store-id <store_id> --strict-attach --target-host ttaiex.nextsls.com --full
lxeskill logistics tiantai query --store-id <store_id> --account-name '<当前公司账户全名>' --fba <完整FBA> --expected-warehouse <原表目的仓>
```

同一环境已打开两个天泰账号页面时，不退出重登，也不要求关闭其中一个。先通过 `ziniao-browser` 枚举同域标签页，再逐页快照确认公司，按实时 handle 轮询：

```text
lxeskill browser page --action browser_tabs --store-id <store_id> --strict-attach --target-host ttaiex.nextsls.com
lxeskill browser page --action browser_snapshot --store-id <store_id> --strict-attach --target-host ttaiex.nextsls.com --target-handle <handle_A> --full
lxeskill browser page --action browser_snapshot --store-id <store_id> --strict-attach --target-host ttaiex.nextsls.com --target-handle <handle_B> --full
lxeskill logistics query --profile-id <账号A的配置ID> --store-id <store_id> --target-handle <handle_A> --account-name '<A页面确认的公司全名>' --fba <完整FBA> --login-mode reuse
```

独立天泰命令同样接受 `--target-handle`。统一入口指定 handle 后默认 `reuse`，不允许 `auto`：该流程复用已登录页面，不把配置选择当作账号切换。每次查询在选定页面原上下文再次检查域名和预期公司可见后才发请求，结果保留实际 `target_handle`。handle 失效、页面关闭、域名变化或公司不符时停止受影响项，不自动换另一个页面或尝试其他账号。两个页面显示同一公司或公司无法区分时，不能宣称已建立两个不同账号映射；公司可见仍不等于权威核验登录用户名。handle 只用于本次实时操作，不持久化绑定。未传 handle 时仍要求域名唯一；当前定向查询参数仅接入天泰，其他物流商不扩大支持结论。

命令通过官方配对 Selenium 严格附着已有页面，在固定 `http://ttaiex.nextsls.com` origin 内 POST `/rest/tms/wos/shipment/lists`。请求固定复现已经抓取并成功返回 `activeTab=all` 的 Payload：`activeTab=all` 与页面原始 `isActiveTab=in_transit` 分别保留，不把威飒参数套入天泰。调用方不能传 URL、脚本、请求头、密码、Cookie 或认证值；命令不导航、不自动重试、不启动或重启店铺，也不切换公司账户。

- 保留原始 `input_fba`。默认 `identifier_kind=auto` 仅识别末尾 `U+六位数字` 的箱号后缀，`U` 属于箱号，不属于主号。例如 `FBA15MN7QKMDU000001` 拆为主号 `FBA15MN7QKMD` 和 `box_suffix=U000001`，按主号查询，并与 `data.components.gridView.table.dataSource[].shipment_id` 中的 FBA 精确核对；不做模糊或前缀匹配。独立和统一入口均接受 `--identifier-kind auto|shipment|box`；`shipment` 明确保留整个输入，`box` 要求完整后缀。不按固定长度切主号，不自动删除孤立的 `U` 或未知后缀。
- `identity_verified` 只表示主号对应；`box_identity_verified=false`，主号命中不能证明该箱归属，也不能把整票件数或转单号分配给某一箱。保留所有匹配行、原始箱号和规范化规则，不用天泰运单号代替 FBA。
- 有返回行却无法核对 FBA 时，返回 `status=identity_unverified`，保留 `identity_evidence` 中的原字段和提取到的 FBA，不把 `total=1` 当命中，也不解释为货件不存在。其他字段是否可用于身份核对须有真实返回证据，不能猜扫描备注代替核对。
- `account_name` 必须来自本次快照。`account_visible=true` 只表示页面可见文本包含该名称，不能证明两个天泰账户可以互换，也不是长期店铺归属配置。
- 当前真实样本 `FBA15MPDN5VF` 返回天泰运单 `TAI10727074`、服务“欧洲空派递延-带D”、Amazon 德国 `02977`、件数 2、仓库“龙华仓”，响应页签为 `all`，业务状态计数为“已收货(1)”。该票是德国样本，只验证列表请求、完整 FBA 身份和字段投影，不算美国 FBA 验收。
- 当前行没有 `to_warehouse_code`，`outer_carrier="--"`，也没有最终送达 ETA。命令因此返回 `warehouse/carrier/eta=null`、`tracking_numbers=[]` 并列出缺项；“龙华仓”是物流商仓库，不能替代 Amazon 目的仓。
- 用户新增真实行 `FBA15MN7QKMD / TAI10723968` 的 `outer_carrier` 明确显示 UPS、一个转单号 `1ZK3526F6802707236` 和“已生成”。仅对该已观察的三行布局解析 `carrier=UPS`、单个 `tracking_numbers`、`carrier_status_text=已生成`，原 HTML 一并保留；其他承运人、状态和多号布局仍报告 `tracking_layout_unverified_for_tiantai`。“已生成”是天泰转述，不证明 UPS 已收件或已送达，不作为官方日期依据。
- `parcel_count` 的真实样本为数字；威飒已另观察到 HTML 字符串和数字两种形状，各适配器分别按证据处理并保留。`created` 是下单时间原值，不作为 ETA、签收时间或改期依据。
- 默认只读取第 1 页。`complete=false` 时说明其他页未查；真实空结果合同尚未取得，空列表报告 `empty_result_unverified`，不擅自解释为无货、登录过期或账户错误。
- 检查顶层 HTTP、`success/info/errorCode/errors`、列表、分页和 `returned_active_tab`。HTTP/provider/JSON/网络/Selenium 错误保留实际脱敏诊断；失败即停，不调用马帮认证刷新。

历史票 `FBA15MPDN5VF` 已在当前快照显示的账户“深圳市新棱镜贸易有限公司”下完成两次独立受控实页查询。两次均唯一命中 `TAI10727074`、`complete=true`、`all_tab_confirmed=true`，业务字段及缺项一致，`queried_at` 分别为 `2026-10-19T03:04:58Z` 和 `2026-10-19T03:13:29Z`。用户此前提供的“深圳市雷袖尔科技有限公司”与执行时页面不一致，未用于查询，不能记录为已核实账户。该历史票无需第三次重复；第二个公司账户、美国样本、非空尾程字段、空结果、失败响应和在途最终送达 ETA 分别补证，不从本票扩大结论。

2026-10-22 用户回传天泰自动登录通过，但未明确两个配置是否均完成测试，不扩大为双账号全流程通过。新增德国真实行已提供上述 UPS 字段证据；箱号规范化及新解析仍需加载修复后代码完成实页复验。`FBA15MN7QKMDU` 多出孤立的 `U`，不能当作该样本的主号。

# 飞沃运通单票查询

飞沃可直接查询，不要求登录凭据或已登录状态。现有命令仍通过 LXE_Agent 真实执行会话及官方配对 Selenium 查询；先按 `ziniao-browser` 检查指定店铺运行状态，再读取当前唯一飞沃页面：

```text
lxeskill browser page --action browser_snapshot --store-id <store_id> --strict-attach --target-host feichi.nextsls.com --full
lxeskill logistics feiwo query --store-id <store_id> --fba <完整FBA>
```

唯一目标标签页须为 `http://feichi.nextsls.com/tracking/app`（可以带查询参数和 `#/tracking` 路由）。该网页支持 `#/tracking?numbers=<FBA1>,<FBA2>` 自动逐票查询，这是页面入口；本命令每次仅查询明确授权的一个 FBA。没有指定页面时由用户打开，不启动、重启店铺，不替换其他业务标签页。

命令通过官方配对 Selenium，在原页面内 GET 固定路径 `/tracking/app?inajax=1&tracking_number=<完整FBA>`；不接受 URL、脚本、请求头、密码或 Cookie 参数，不猜账户身份，也不宣称接口无需认证。没有自动重试、批量扫描或账号切换。

- 核对顶层 `ok`、`request_succeeded`、`found` 和 `matched_count`。`data.shipment.ext_number` 必须与输入完整 FBA 精确一致，不能截断箱级后缀或用内部运单号代替。返回不同 FBA 时失败，不能取来当目标票。
- `matches` 包含运单、承运人、转单号、状态、件数、国家、邮编、全部有界轨迹及 `source_fields` 原文。只有显式承运人前缀加单个号码的已知布局才去除前缀；不明布局保留原文并报告缺项，不猜多号码对应关系。
- 当前真实样本没有仓库代码。`warehouse=null`、`warehouse_matches=null`；邮编和轨迹城市不能替代目的仓。可传 `--expected-warehouse` 保留核对需求，但仍返回未核实。
- `eta=null`，不能把预计到港、清关或历史签收日期当最终送达 ETA。`shipment_status=delivered` 只表示该接口返回的状态，不用于生成未来改期建议。
- `traces` 保留网站原始顺序和日期文本，时区未知。不把第一条轨迹当签收时间；样本里最新一条到站事件晚于签收事件，两条都保留，不擅自纠正。飞沃转述的 FedEx 轨迹不是独立访问 FedEx 官网的验证。
- `queried_at` 是本次 UTC 查询时刻；`provider_request_time` 是物流接口返回的原文时间，时区未证实，不能混用。`complete=true` 只表示本次响应投影未截断且结构/身份通过，不证明所有包裹、历史转单或在途状态均已覆盖。
- 响应上限 2 MiB、单字段 8000 字符、轨迹 200 条；任何超限都显式标记并失败，不用截断后的编号匹配。缺字段和多包裹风险通过 `missing_fields`、`warnings` 报告。
- 未取得飞沃空结果/失败响应契约；`status!=1` 或缺少货件对象时保留真实状态、`info` 或结构错误，不能自行解释成查无货或登录过期。HTTP/JSON/网络/Selenium 错误同样原样脱敏保留，停止后让用户处理，不执行马帮认证刷新。

2026-10-14 用户提供的 `FBA191GB5WTM` 是已签收历史票，可验收查询，不做改期。实现及真实响应 fixture 的本地测试不等于 LXE_Agent 实页验收；须独立重复查询并比较货件字段与新查询时间。其他 FBA、多包裹、空结果和在途数据分别验收后再扩大范围。

# 云驼单票查询

在 LXE_Agent 真实会话中，先按 `ziniao-browser` 查询店铺状态，再读取唯一云驼页面并核对当前公司账户：

```text
lxeskill browser page --action browser_snapshot --store-id <store_id> --strict-attach --target-host vip.yjtms.com --full
lxeskill logistics yuntuo query --store-id <store_id> --fba <完整FBA>
```

已保存凭据时可先执行 `lxeskill logistics login --profile-id <UUID> --store-id <store_id>`，或由统一查询默认 `auto` 登录。登录执行器只接受当前唯一 `vip.yjtms.com` 标签页：未登录时须为固定的 `https://vip.yjtms.com:11000/viplogin`。真实源码显示 Element UI 登录区没有原生 `<form>`，固定控件是 `placeholder=LOGIN_ACCOUNT` 的文本框、`placeholder=PASSWORD` 的密码框及文本为 `LOGIN_LOGIN` 的 `type=button`；执行器要求三者唯一、可见、启用且位于八层以内的同一控件组。凭据仍只从 Desktop 私有 stdin 进入配对 Selenium。真实登录落点为 `/home`，页面文本中的 U+00A0 先归一化为普通空格，再要求同时读到“快速下单、批量下单、财务结算、SYSTEM SETTING”才视为已登录工作台；随后在同一标签页导航到固定 `/customer/trackquery/`，并以该路径上密码框消失确认查询就绪。其他落点原样报告并停止。验证码、结构歧义、跨源、未知页面或实际错误同样停止，不重试。

目标页面必须为 `https://vip.yjtms.com:11000/customer/trackquery/`，可带原有查询参数。页面未打开、域名匹配不唯一或账户不明时停止处理对应项；不替换其他标签页、不启动或重启店铺。`store_id` 沿用本次核实的真实值，不能照抄历史运行状态。

命令通过官方配对 Selenium，在原页面中复用唯一 `$httpService.getRequestHeader`，为固定参数 `{noList: <完整FBA>, queryType: 99}` 生成认证头，再 GET 固定同源路径 `/tms-saas-oms/oms/tms/tracequery/list`。原生函数内部管理认证；适配器不自行枚举存储、提取原始 token 或导出 Cookie/token/sign，不复制签名算法、不持久化认证材料。不调用会丢失错误详情的页面通用 `.get`。调用方不能指定 URL、脚本、请求头或认证值。

- 检查顶层 `ok`、`request_succeeded`、`found`、`matched_count` 和 `complete`，并报告 warnings/missing_fields。`body[].referenceno` 必须精确等于完整 FBA，不能截断后缀或使用第一个近似结果。
- `jobno` 为云驼运单号，`refno` 为转单号（已有 `getTrack` 源码字段标签证据），`referenceno` 为参考编号。已观察单个字母数字转单布局才输出 `tracking_numbers`；原始 `source_fields/refno` 一并保留，未知多号或前缀布局不猜拆分。
- 真实样本 `carrier=""`，因此 `carrier=null`；不按 `1Z` 格式或轨迹提到 UPS 就认定承运人。`destName=US-美国` 不是 Amazon 仓库；`warehouse/warehouse_matches/eta/parcel_count` 未提供时保留为空，不由城市、国家或参考编号补猜。`--expected-warehouse` 只保留核对需求。
- `podInfoDTOList` 按原始数组顺序输出全部有界轨迹，保留 `scanTime`、`scanDatetime`、状态、站点和备注，不把第一条自动当作实际签收时间。时间文本与数值分别保留；请求头时区不能证明目的地业务时区。备注中 LONG BEACH 的 ETA 是到港日期，不能当最终送达 Amazon 仓库的日期。
- 页内服务扫描上限 2000 个元素，匹配服务零个、多个或扫描截断时失败；未知生成头字段也失败。响应 2 MiB、最多 100 行、每行 200 条轨迹、单字段 8000 字符；超限显式失败。`complete=true` 只说明本次投影完整，不证明全部包裹、历史转单或在途能力。
- HTTP/provider/网络/原生头生成/Selenium 异常保留实际脱敏诊断，失败即停；不自动重试、切换账户或刷新登录。空结果真实契约尚无样本，`empty_result_unverified` 不表示已经证实无货。自动登录失败时保留真实表单证据，由用户处理验证码或页面异常，不调用马帮认证刷新。

2026-10-16 用户回传 `FBA19P9T04B2` 两次独立真实查询通过摘要：HTTP 200、`result_code=0`、完整 FBA 精确匹配 1 行、`complete=true`，运单 `999260910003548`、转单 `1Z16HE510305235582`、20 条原顺序轨迹及缺项一致，查询时间和 traceId 更新。该历史票无需第三次重复；其他账户、空结果、失败、多包裹及在途 ETA 仍分别等待真实样本，不扩大已通过结论。两次运行仍依赖日志写入的一次性沙箱权限放宽，未视为已修复。后续失败保留实际结果，不重启补救。查询不授权物流订单、原表或 Amazon 写入。
