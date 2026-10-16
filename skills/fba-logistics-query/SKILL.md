---
name: fba-logistics-query
description: 按完整 FBA 标识查询威飒、飞沃运通或云驼的运单、转单号和已有物流信息。威飒可核对目的仓，飞沃和云驼可读取轨迹；承运人缺失明确报告，当前不提供已核实的尾程 ETA 或 Amazon 改期。
type: ziniao_browser
commands:
  - lxeskill logistics wesa query
  - lxeskill logistics feiwo query
  - lxeskill logistics yuntuo query
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

# 飞沃运通单票查询

在 LXE_Agent 真实执行会话中，先按 `ziniao-browser` 检查指定店铺运行状态，再读取当前唯一飞沃页面：

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

目标页面必须为 `https://vip.yjtms.com:11000/customer/trackquery/`，可带原有查询参数。页面未打开、域名匹配不唯一或账户不明时停止处理对应项；不替换其他标签页、不启动或重启店铺。`store_id` 沿用本次核实的真实值，不能照抄历史运行状态。

命令通过官方配对 Selenium，在原页面中复用唯一 `$httpService.getRequestHeader`，为固定参数 `{noList: <完整FBA>, queryType: 99}` 生成认证头，再 GET 固定同源路径 `/tms-saas-oms/oms/tms/tracequery/list`。原生函数内部管理认证；适配器不自行枚举存储、提取原始 token 或导出 Cookie/token/sign，不复制签名算法、不持久化认证材料。不调用会丢失错误详情的页面通用 `.get`。调用方不能指定 URL、脚本、请求头或认证值。

- 检查顶层 `ok`、`request_succeeded`、`found`、`matched_count` 和 `complete`，并报告 warnings/missing_fields。`body[].referenceno` 必须精确等于完整 FBA，不能截断后缀或使用第一个近似结果。
- `jobno` 为云驼运单号，`refno` 为转单号（已有 `getTrack` 源码字段标签证据），`referenceno` 为参考编号。已观察单个字母数字转单布局才输出 `tracking_numbers`；原始 `source_fields/refno` 一并保留，未知多号或前缀布局不猜拆分。
- 真实样本 `carrier=""`，因此 `carrier=null`；不按 `1Z` 格式或轨迹提到 UPS 就认定承运人。`destName=US-美国` 不是 Amazon 仓库；`warehouse/warehouse_matches/eta/parcel_count` 未提供时保留为空，不由城市、国家或参考编号补猜。`--expected-warehouse` 只保留核对需求。
- `podInfoDTOList` 按原始数组顺序输出全部有界轨迹，保留 `scanTime`、`scanDatetime`、状态、站点和备注，不把第一条自动当作实际签收时间。时间文本与数值分别保留；请求头时区不能证明目的地业务时区。备注中 LONG BEACH 的 ETA 是到港日期，不能当最终送达 Amazon 仓库的日期。
- 页内服务扫描上限 2000 个元素，匹配服务零个、多个或扫描截断时失败；未知生成头字段也失败。响应 2 MiB、最多 100 行、每行 200 条轨迹、单字段 8000 字符；超限显式失败。`complete=true` 只说明本次投影完整，不证明全部包裹、历史转单或在途能力。
- HTTP/provider/网络/原生头生成/Selenium 异常保留实际脱敏诊断，失败即停；不自动重试、切换账户或刷新登录。空结果真实契约尚无样本，`empty_result_unverified` 不表示已经证实无货。登录失效时由用户完成验证，不调用马帮认证刷新。

2026-10-16 用户回传 `FBA19P9T04B2` 两次独立真实查询通过摘要：HTTP 200、`result_code=0`、完整 FBA 精确匹配 1 行、`complete=true`，运单 `999260910003548`、转单 `1Z16HE510305235582`、20 条原顺序轨迹及缺项一致，查询时间和 traceId 更新。该历史票无需第三次重复；其他账户、空结果、失败、多包裹及在途 ETA 仍分别等待真实样本，不扩大已通过结论。两次运行仍依赖日志写入的一次性沙箱权限放宽，未视为已修复。后续失败保留实际结果，不重启补救。查询不授权物流订单、原表或 Amazon 写入。
