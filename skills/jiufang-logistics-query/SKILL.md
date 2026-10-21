---
name: jiufang-logistics-query
description: 用一个 FBA 主号或箱级编号查询九方通逊公开专线轨迹。自动识别已验证箱号后缀并核对返回 FBA；支持一张运单关联多个 FBA，保留整票统计范围。无需登录、物流账户或紫鸟店铺，不提供已核实的尾程 ETA 或 Amazon 改期。
type: default
commands:
  - lxeskill logistics jiufang query
---

# 九方通逊单票查询

有启用的九方配置时，可用统一入口：

```text
lxeskill logistics profiles --provider jiufang
lxeskill logistics query --profile-id <九方配置UUID> --fba <完整FBA或箱号> --expected-warehouse <目的仓>
```

统一入口不要求 LXE 会话、紫鸟店铺或 Desktop 登录服务，禁止给九方传 `store_id/account_name` 或 `--login-mode auto`。保留原匿名适配器及箱号规则，业务证据在 `data.result`；配置仅选择固定供应商，不能借九方技能转调浏览器物流商。无需配置时继续使用原独立命令。

整体任务包含 Amazon 改期建议或修改时，先由 `fba-shipment-delivery-window` 在当前目标 Amazon 店铺执行只读 discovery，确认完整 FBA 的归属，再进入本技能并沿用该映射。九方公开查询自身不操作店铺，也不能证明 Amazon 货件归属；独立查询九方不要求这个前置检查。

在 Amazon 改期流程中，本模块用于核对 FBA、目的仓及已有转单信息。取得已核实的尾程承运人和转单号后，继续查 UPS/FedEx 等实际承运商的官方追踪；九方到港、到仓日期和转述轨迹不作为改期日期依据。`eta=null` 不阻止下一步尾程查询，但本模块当前非空转单字段仍未完成结构验证，不能据号码前缀猜承运人。建议规则见 [尾程证据与改期建议](../fba-shipment-delivery-window/references/carrier-evidence.md)。单独查询九方不自动进入改期。

通过 `exec` 独立调用 CLI，每次只查用户指定的一个 FBA：

```text
lxeskill logistics jiufang query --fba FBA15GJ013CQU000001 --expected-warehouse XSY2
```

命令 POST 固定公开接口 `/test-api/seaair/waybills/selectWaybillStatusByWaybillNo`，正文为一个 FBA 主号组成的数组。不使用 Cookie、Authorization、账号配置或浏览器会话；2026-10-16 已用 `FBA15GJGP83C` 不带认证查询成功。官网顶部搜索框的登录/格式限制不等于该接口需要登录。失败保留实际脱敏 HTTP、业务状态和异常，不自动登录、刷新认证或重试。

## 编号与身份核对

- 原始 `input_fba` 原样保留。默认只识别末尾 `U` 加六位数字，例如 `FBA15GJ013CQ` + `U000001`；整个后缀一并移除，不能把 `U` 留在主号里。主号不按固定长度切分，未知格式不猜切。
- `--identifier-kind shipment` 明确输入本身就是主号，完全不去后缀；`--identifier-kind box` 要求已知箱号后缀。真实主号恰好以相同形状结尾或编号性质不明时，先核对来源，再选择参数，不能盲目尝试多个变体。
- 拆分结果只是候选。返回的 `shipmentId` 按已观察的英文逗号拆分并逐个完整匹配；只有 `identity_verified=true` 才确认关联。不用参考号、子串、第一条结果代替身份核对。
- `SP260914001` 在用户表中是发货/贴标分组，同号曾查询到不同 FBA、德国 DTM1 卡铁货件。本票澳大利亚 XSY2 的实际九方参考号是 `FBA15GJ013CQ-FBA15GJ1LNL0`，不得凭表内 SP 号匹配。
- 同一主号的多个箱行可在已明确授权的表格处理中复用该主号的一次查询结果，但本命令不读取表格、不批量扫描、不自动查询其他 FBA 或账号。

## 结果范围

- 读取 terminal 顶层 `ok` 以及 `data.request_succeeded/found/identity_verified/complete/matches`。空响应契约尚缺真实样本，`empty_result_unverified` 不代表已经证实无货。结构异常、身份不匹配和网络错误均不能改写成“查无货”。
- `fba_numbers` 保留运单关联的全部 FBA；`parcel_count/weight/volume` 是整张运单的统计。两个 FBA 共用一张运单时，不把整票箱数或重量分配给单个 FBA 或箱行。
- `destination` 保留原文，只对已知 `国家-FBA-仓库代码` 布局读取目的仓。`warehouse_matches=false` 时报告冲突，不继续生成可执行业务建议。
- `trackNumber` 的原文保留在 `source_fields`；已有空值 fixture 和用户回传的非空字段摘要。非空号码的承运人及结构化提取仍待验证，当前继续报告 `tracking_layout_unverified`，不猜拆分或承运人。缺项和 warnings 必须报告。
- `lines` 保留原顺序、`state`、状态码、时间和备注。`state=false` 的未来阶段不能描述为已完成；时区未证实。到港、到仓日期不等于最终送达 ETA。
- 两份用户真实响应分别是单 FBA 单箱 `FBA15GJGP83C`、双 FBA 共用运单 `FBA15GJ013CQ/FBA15GJ1LNL0`，均为澳大利亚已签收历史票。可用于物流查询验收，不扩展为美国站或改期闭环已验证。
- 响应最多 2 MiB、100 行、每行 200 条轨迹、单字段 8000 字符。超限显式失败，不以截断内容做身份匹配。`complete=true` 仅表示本次结果解析完整，不证明所有箱子的尾程号码覆盖。

查询不授权物流订单、表格或 Amazon 写入。此公开 HTTP 模块不操作浏览器；涉及紫鸟页面的其他物流功能继续遵守官方配对 Selenium 链路。

2026-10-19 归档补充：用户另回传两票加拿大历史货件成功摘要。`FBA19Q19JQ9QU000001` 拆为 `FBA19Q19JQ9Q`，运单 `ZX2609LD88`、YYZ7、整票3箱/51 kg/0.15 m³；`FBA19PRMX9HVU000001` 拆为 `FBA19PRMX9HV`，运单 `ZX2609QF23`、XYY4、整票1箱/13.6 kg/0.05 m³，两票均 `identity_verified=true`。第二票原始 `trackNumber=1ZB35H402036640441`，目前仅保留原文，不按前缀认定承运人。证据为用户摘要，未取得这两次完整 terminal JSON、查询时间或可归档的原始响应，不伪造成 fixture；同票无需再次重复。两次启动均仍依赖运行日志写入的一次性沙箱权限放宽，不能表述为执行环境问题已修复。
