# 美国 FBA 物流查询与送达时段更新交接

- 日期：2026-10-12。
- 状态：威飒单票查询、精确货件匹配、转单号提取及最终独立回读已通过；`FBA19PWM5L6T` 对应 `PSP3`、UPS `1ZK1013D0321365378`，威飒显示已签收。最新交接以第 15 节为准；第 10—14 节保留历史排查和当时的待办，不代表当前仍未完成查询。
- 下一轮入口：威飒首轮单票已收尾，不重复从零排查元素。用户明确继续第二阶段后，可对上述 UPS 转单号做尾程只读核验；这票已签收，不能直接生成改期建议。此前跳回首页及页签变化的原因仍未确定。不得修改 Amazon、物流订单或原始表格。
- 原交接代码基线：`8529df3c fix: avoid redundant FBA page navigation`，分支 `codex/fba-delivery-window`；原交接轮仅归档文档。
- 本轮代码基线：`25efb1c2 fix: recognize DOM onclick handlers in browser snapshots`；129 项定向测试通过，未合并到 `main`。

## 1 业务范围和已确认结论

销售现有人工流程是：按 FBA 找对应物流商，在物流商后台查转单号，到尾程派送商查询送达时间，再修改 Amazon 送达时段。本期只覆盖 Amazon 美国站，其他国家暂时没有改期需求。

销售知道物流商，而且发货表已有物流商字段。因此主入口调整为表格批量导入，不要求销售逐票重复输入物流商或让 AI 遍历所有物流网站查找。AI 先查询、输出带依据的汇总建议，销售一次批准全部或部分建议，最后批量修改并逐票回读。上传表格只授权按明确范围查询，不代表批准改期。

保留两种模式：

| 模式 | 输入和行为 |
| --- | --- |
| 查询后建议 | 表格或店铺、物流商、FBA 清单；补查转单号及预计送达日期，形成建议后等待销售批准 |
| 按指定日期执行 | 销售明确提供店铺、FBA 和目标日期或时段；使用现有 Amazon 执行链，不默认追加物流查询 |

FBA 是货件定位依据，不是改期日期的依据。物流网站的预计最终送达日期才是建议来源；Amazon 编辑入口、截止时间和日历可选状态决定是否能执行。按钮能点击不等于应该改到某一周。

## 2 表格输入及已核实样本

来源：用户文件 `/Users/lxe-3/Downloads/测试.xlsx`，工作表 `Sheet1`，范围 `A1:P16`。本轮只读分析，没有改写或导出。该文件是测试样本，不代表全部在途货件，也不保证其中货件当前仍可改期。

样本有 15 条数据、15 个不同 FBA，3 个发货单，店铺均为 `Amazon-Yunjian-US`。物流商分布为威飒 8 票、飞沃运通 3 票、天美通 4 票；`J2:J16` 跟踪单号全部为空。

| 列 | 原字段 | 使用规则 |
| --- | --- | --- |
| A、B | 发货单号、箱子编号 | 销售展示及原始记录追溯，不是尾程转单号 |
| D | FBA货件号 | 定位货件；样表为货件级编号，其他原表可能出现带 `U000001` 后缀的箱级标识 |
| E | 仓库代码 | 核对目的仓 |
| G | 物流 | 含物流商和渠道，例如 `威飒-出口退税`；通过明确名称映射到供应商 |
| I | 提货日期 | 筛选参考，不是预计送达日期 |
| J | 跟踪单号 | 先核验含义与承运人；为空时去物流商查，不能将 FBA 箱标识当 UPS/FedEx 单号 |
| K至N | 物流下单、发货、后台创建货件、出库 | 业务参考；勾选不证明已签收或 Amazon 当前允许改期 |
| O | 物流 | 运输渠道，例如 `出口退税-空运`，不得与 G 列物流商混用 |
| P | 店铺 | 与紫鸟真实店铺、站点及公司账户建立明确映射 |

同一发货单不能共用一个物流结果：`SP260911003` 下有威飒和天美通；`SP260917001` 下有飞沃运通和天美通。查询、核对、修改必须逐票对应。目的站点以实际店铺配置核验，不只按名称中的 `US` 推断。

首轮测试样本为 `Sheet1!A2:P2`：

- 店铺：`Amazon-Yunjian-US`。
- 既有目标紫鸟店铺：`Amazon-Yunjian-US 深圳市久艺电子商务有限公司`。
- 用户提供的店铺 ID：`VycOXC1cvUBC/rBIOnYXUg==`，测试时仍须核对真实状态。
- 发货单号：`SP260911003`；箱子编号：`1号箱`。
- FBA：`FBA19PWM5L6T`；目的仓：`PSP3`。
- 物流字段：`威飒-出口退税`；跟踪单号为空。
- 若该历史货件无结果，分别报告查询动作是否执行和业务数据是否找到，不把空结果算作完整通过；由用户提供一票已知可查的威飒货件后再验证。

## 3 物流入口与账户对应

以下地址来自用户，不表示已验证网络、登录或自动化。公开入口只用于定位；不从 URL 推断内部查询能力，不复制授权参数、密码或 Cookie 到代码和文档。

| 物流商或业务 | 入口 | 本期处理 |
| --- | --- | --- |
| 云驼 | `https://vip.yjtms.com:11000/viplogin` | 美国货件实际使用时接入 |
| 九方通逊 | `https://www.jiufanglogistics.cn/` | 美国货件实际使用时接入 |
| 威飒 | `http://wsaexp.nextsls.com/wos` | 第一家验证 |
| 飞沃运通 | `http://feichi.nextsls.com/tracking/app#/tracking` | 后续验证；用户原链接中的 `numbers` 是示例，不固定为测试清单 |
| 掌柜 | `http://120.76.63.228:5001/#/login` | 美国货件实际使用时接入；原链接的 `wework_cfm_code` 已省略，不写死临时授权信息 |
| 日本乐天物流博洋优选账户 | `http://client.wy-global.com/` | 当前日本业务不纳入本期改期流程 |
| 合联国际 | `https://portal.vnlin.com/` | 用户说明可下单取得快递单号；本期仅评估美国现有货件的查询，不授权下单 |
| 元速物流墨西哥美客多 | `https://yes-speed.com:84/fbaOrder/index` | 当前业务不纳入本期 |
| 拉美无忧物流巴西美客多 | `https://tms.mabangerp.com/#/default` | 当前业务不纳入本期 |
| 天泰供应链 | `http://ttaiex.nextsls.com/tms/wos/home` | 用户清单第 10、11 项是两个公司账户，不是可以删除的重复账户；保留两个账户与适用店铺的映射 |
| 天美通 | 无后台系统 | 与天泰不同；使用消息文本或截图补充转单信息 |

同一网址可共用网站操作适配，但公司账户和权限必须分别配置。账户名称及店铺归属尚待业务补齐，不能自行编造。物流商、账户、店铺/站点、运输渠道分别建模，不用名称相近的模糊匹配代替确认。

## 4 天美通消息入口和数据冲突

销售确认天美通是独立物流商，没有后台系统，由物流商直接发送包含 FBA、目的仓、件数和转单号的消息。销售可粘贴文本或上传截图，由 AI 提取并与表格核对；只有信息缺失、截图不清或关系冲突时才要求补充。不需要每次人工重抄，亦不默认读取整个聊天群。

本轮聊天截图中 `FBA19QHG9TR3` 的目的仓是 `SMF2`，而样表 `Sheet1!D16:E16` 是同一 FBA 对应 `SWF2`。这是待核对的实际冲突，不确定哪份资料正确。后续结合 Amazon 真实货件资料核对，解决前不得自动生成可执行的改期项。

消息中的费用、重量不是送达日期。提取转单号后仍需向实际尾程承运人查询。UPS 的 `1Z` 格式、FedEx 数字长度只作辅助校验，不单凭格式判定承运人；渠道写 `DHL/UPS` 不代表实际已经确定承运人。

## 5 统一流程和结果要求

1. 导入表格，明确处理行范围，筛选并核验美国站店铺；保留源文件、工作表和行号。
2. 区分货件号、箱级标识、内部发货单号。以店铺加完整 FBA 为货件键，保留箱级对应，不盲目截断编号。
3. 按物流商及公司账户分组。有后台的进入后台查询；天美通读取本次提供的消息。遇到未接入供应商只暂停对应项，不遍历所有网站猜测。
4. 逐票取得零个或多个转单号及承运人、目的仓；核验匹配关系，不取第一个结果代替整票。
5. 查询尾程预计最终送达 Amazon 仓库的日期，记录原文、来源和查询时间，按目的地当地日期理解。到港、清关、交给尾程均不能替代最终送达日期。
6. 获取 Amazon 当前送达时段及实际可编辑状态，形成建议。已有时段按页面原文读取，不假定一律 7 天；建议目标日历周沿用现有规则并接受页面验证。
7. 多包裹日期落同一周可形成一致建议；跨周、部分无日期、已签收、目的仓冲突、无权限等单独展示，不擅自取最早或最晚日期。
8. 汇总后销售一次批准全部或指定项目。批准前展示具体 FBA 对应及目标时段；执行前重核身份、资格和建议是否发生实质变化，变化项暂停。
9. 复用现有 Amazon 执行链，逐票回读新时段，报告成功、未修改及真实原因，不以点击成功代替业务成功。

操作表默认用固定的本次序号，例如 `货件编号 1`，并带原发货单、箱号、目的仓帮助识别。完整 FBA 保留为核对明细；不要让销售背编号。报告生成后重新读取不得悄悄改变批准序号的对应关系。

建议表至少包含店铺、货件序号、物流商、目的仓、转单号数量、尾程承运人、预计送达日期、当前时段、建议时段、原因、查询时间和异常。明细保留 FBA 到转单号的对应和网站原文。分别表达是否找到数据、是否需要修改、页面是否允许、是否已批准、是否已提交并回读。

## 6 已有能力和本轮真实检查

已有 Amazon 执行命令：

- `lxeskill fba shipment delivery-window-list`。
- `lxeskill fba shipment delivery-window`，含 discovery、dry-run 和 apply。
- 说明见 `skills/fba-shipment-delivery-window/SKILL.md` 和 [20261009 执行方案](20261009-fba-delivery-window-apply.md)。历史单票真实写入已在旧文档记录，本轮没有再次写入。
- 当前额外业务门槛仍为列表 `orderStatus="已发货"`；页面可编辑与业务允许分开报告。本轮没有授权或实现取消该门槛。

已有通用浏览器工具支持页面快照、截图、网址导航、点击、输入、滚动和批量 steps。所有紫鸟页面操作必须使用官方配对的 `SeleniumRunner` 和按 `core_version` 匹配的 chromedriver，不使用 Playwright、Puppeteer 或裸 CDP。

本轮执行了以下真实状态检查：

```text
uv run --frozen lxeskill browser store --action get_status
```

首次被沙箱访问 uv 缓存的权限限制阻挡；获准在沙箱外执行后，退出码为 3，返回：

```json
{"protocol_version":"1","type":"result","command":"browser store --action get_status","ok":false,"data":{},"files":[],"error":{"code":"session_required","message":"browser store requires an LXE session"}}
```

这只证明当前 Codex 终端没有该命令要求的 LXE 执行会话，不证明紫鸟未运行或威飒未登录。不得伪造会话 ID、复制别的会话状态或在 Python 读取 Bun 会话 DB。下一轮应在 LXE_agent 实际会话及其注入环境中测试。本轮没有进入物流商页面，没有验证任何一家物流商的登录态或自动化，也未实现物流查询命令。

## 7 浏览器层的首轮前置检查

原交接时确认两个风险。后续已添加可选的严格附着和精确域名定位；默认旧行为仍然存在，续测时必须显式带安全参数（见第 10 节）：

1. `services/browser/store/store_driver_session.py` 每次附着调用 `select_first_normal_tab`；`services/browser/tools/driver_session.py` 会选择第一个普通 http(s) 标签页，不按当前任务的物流商域名、账户或指定标签页绑定。多站点下可能选错页面，但这不是此前跳回现象已经实测确认的唯一原因。
2. `store_driver_session` 附着遇到 `RuntimeError` 会调用 `ensure_store_session(..., force_restart=True)` 再试。仅在提示词里写“不重启”不能阻止底层自动重启。

首轮在调用会触发附着的页面动作前，先核对上述行为。若测试要求复用且不重启，需先实现有测试覆盖的严格附着、失败即停模式，或由用户明确选择允许的生命周期行为；不能声称当前已有“附着失败绝不重启”的保证。相关修复属于下一轮受控实施，本轮归档没有修改它们。

目标设计是按店铺、物流商域名和目标标签页稳定定位；匹配不唯一时停止，读取不导航、不切回 Amazon，连续调用不丢失目标。不同物流公司账户分别核对，不能只看网址正确。沿用同店铺操作锁，避免批量并发点击同一环境。

## 8 下一轮威飒单票测试

首次测试不做表格批量导入开发、不接全部物流商、不查尾程 ETA、不进入 Amazon 改期。先验证威飒这一段，拿到可靠转单号后才进入第二阶段尾程查询。

准备条件：

- 在 LXE_agent 的真实执行会话中运行；按 `skills/ziniao-browser/SKILL.md` 使用 canonical CLI。
- 目标紫鸟环境及公司账户明确，优先复用已运行环境。由用户在该环境打开威飒并完成首次登录/验证码，不从聊天中索取明文密码。
- 完成第 7 节的页面定位和生命周期检查后再执行页面动作。

| 步骤 | 验收标准 |
| --- | --- |
| 1 状态检查 | `get_status` 返回真实店铺状态，能核对目标 store_id；失败即停 |
| 2 页面定位 | 读取威飒真实 URL、标题、快照，确认不是 Amazon 或别的物流商 |
| 3 登录态识别 | 区分已登录且账户正确、未登录、需要验证、无权限、无法判断；有业务页和账户证据，不把网址打开当成功 |
| 4 单票查询 | 输入 `FBA19PWM5L6T`，点击查询，确认实际查询条件与结果变化；只执行查询 |
| 5 结果提取 | 精确关联 FBA，提取页面实际存在的目的仓、转单号、承运人；缺项原样报告 |
| 6 再次调用 | 独立调用仍定位同一物流页面并复用登录态；不跳回、不自动重启、不丢失查询上下文 |

结果分别报告连接是否成功、是否已登录正确账户、查询动作是否成功、是否找到精确业务结果、是否取得有效转单号、重复读取是否稳定。“命令 ok=true”或查到零行都不能代替全部验收通过。

保留经过必要脱敏的页面证据、查询时间、逐步状态和实际错误。不导出 Cookie、token 或密码；不将登录失败改写为无依据的通用提示；不调用马帮 `auth refresh` 修复物流商登录。

首轮通过后按顺序进入：真实转单号尾程查询、威飒小批量、其他物流商及天美通消息入口、Amazon 建议预演、销售批准后的少量真实改期。每阶段先验证再扩大范围。

## 9 下一轮启动说明

可将下面内容作为下一轮提示词：

> 阅读 `docs/record/20261012-fba-logistics-delivery-window-handoff.md`，以第 15 节为最新交接。威飒单票查询已经完成：当前账户“深圳市新棱镜贸易有限公司”精确查到 `FBA19PWM5L6T`，威飒运单 `WS10026638`，目的仓 `PSP3`，尾程 UPS，转单号 `1ZK1013D0321365378`，状态已签收；截图与最终独立文本回读一致。不要重复 DOM onclick 修复或将历史 aid 当成当前 ref。当前阶段已收尾；若用户要求继续尾程核验，只读查询该 UPS 单号，区分物流商已签收、尾程实际签收时间和预计送达时间，不直接生成或执行改期建议。若用户要求排查稳定性，优先记录实际店铺、标签页身份及动作前后 URL，再定位此前跳回首页和页签变化，不能凭推测归因。真实页面操作仍须在 LXE_Agent 实际会话中走官方配对 Selenium 链路；威飒页面命令带 `--strict-attach --target-host wsaexp.nextsls.com`，新一轮重新核对状态与页面。`browser_snapshot` 可带 `--full`，`browser_vision` 不可带 `--full`。禁止物流下单、修改物流资料、写入 Amazon、改写原表、自动启动或重启、复制或伪造会话、读取 Bun agent DB 或刷新马帮认证。

旧的 [20261007 方案](20261007-fba-delivery-window.md) 保留为历史背景；其中多国家范围和 SP-API 阶段设计不是本期任务。20261009 的“上游物流链路被省略”描述的是当时只接收目标日期的执行范围，不否定本轮新增的查询后建议模式。

## 10 续测：严格附着通过，页面内容提取待实页复验

用户从 LXE_Agent 真实会话回传：`get_status` 成功，目标店铺 `VycOXC1cvUBC/rBIOnYXUg==` 运行中，名称为 `Amazon-Yunjian-US 深圳市久艺电子商务有限公司`，browser_id 为 `16547398293641`。这是用户回传的真实运行结果，当前 Codex 终端未自行执行该会话命令。

安全修复 `a0e4d217 fix: add strict browser page attachment` 已提供 `--strict-attach --target-host wsaexp.nextsls.com`：仅复用已运行店铺，附着失败即停，不启动或重启店铺；域名匹配零个或多个标签页时停止。

用户随后回传普通及 `--full` 严格快照均成功，URL 为 `http://wsaexp.nextsls.com/tms/wos/home`，标题为 `控制台-深圳市威飒国际物流有限公司-全球一体化跨境物流综合服务专家`。完整快照只有 ParcelOS 页脚，refs 为零。此证据支持正文可能在 frame 中，但尚未取得实际 frame 列表，也未确认公司账户或执行 FBA 查询。

本次已实现 frame-aware 快照及动作：

- 通过现有 Selenium 链路遍历顶层及最多 10 个子 frame（含嵌套 frame 和开放 Shadow DOM 中的 frame），所有 document 共用元素和正文预算。
- frame 中的 ref 包含路径和 document 身份；每个元素带 `frame_path`。click/type 进入原 frame 后核验身份，frame 被重排、替换或导航后拒绝旧 ref；成功或失败都回到顶层。
- 快照返回 frame 列表、读取失败的实际错误和截断标记。frame 诊断 URL 去除凭据、查询参数和片段，长错误显式截断。单个 frame 读取失败保留错误并继续兄弟 frame；批量动作失败仍停止，不执行余下步骤。
- 修正正文过滤误删纯中文行，以及重新提取时编号可能复用的问题。无需增加 CLI 参数，`catalog.json` 未修改。

定向验证从仓库根执行，退出码 0，`106 passed`：

```text
uv run --frozen pytest python/lxeskill_cli/tests/browser python/lxeskill_cli/tests/lxeskill/test_lxeskill_browser_session.py python/lxeskill_cli/tests/lxeskill/test_python_tool_boundaries.py python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py
```

其中新增 17 个 frame/提取测试，使用 fake Selenium driver 验证上下文和动作隔离，并用 Bun 对本次实际提取 JS 执行 DOM fixture 验证。它们不代表威飒真实页面已经识别成功。

下一步在同一 LXE_Agent 会话只执行以下完整快照，返回全部 `Frames`、`Visible text`、refs 和错误；未核验公司账户前不查询 FBA：

```text
lxeskill browser page --action browser_snapshot --store-id 'VycOXC1cvUBC/rBIOnYXUg==' --strict-attach --target-host wsaexp.nextsls.com --full
```

## 11 续测：顶层正文可读，非标准导航控件待确认

用户回传更新后的完整快照成功，实际 URL、标题与前次一致，`Frames: (none found)`。正文包含“发货、财务、更多、工具”“深圳市新棱镜贸易有限公司、总控平台”“余额、待核销欠款、待付账单、待出账单”“运单、已下单”，refs 仍为零。

这次结果没有支持 iframe 假设。正文从版权行增加到中文导航及账户名称，也可以由纯中文行过滤修复解释，不能仅凭此差异断定网站发生了动态更新。

用户明确答复不确定该公司账户是否对应测试货件，但允许先在当前账户查询 `FBA19PWM5L6T`，若不对应再核对另一个账户。当前账户名称必须保留在结果中；查无数据本身不能证明账户错误，也不能算业务查询通过。

下一次完整快照已补充：识别原生元素之外的 `menuitem`、`tab` 等交互角色，以及显式 `onclick` 属性和非负 `tabindex`；每个 ref 显示 `detected_by`。若仍为零 refs，返回有界的 `DOM diagnostics`，包含实际 selector 命中数、可见节点数、节点标签、class、role、tabindex 和 cursor。只诊断鼠标手形样式，不将其样本自动当作可点击 ref，不执行事件处理代码。

下一步仍由 LXE_Agent 执行同一条 `--full --strict-attach --target-host wsaexp.nextsls.com` 快照，完整返回 refs 及 `DOM diagnostics`。取得实际导航控件证据后再进入运单查询。当前尚未点击导航，也未执行 FBA 查询。

浏览器模块及第 10 节列出的相关 CLI 定向回归结果为 `112 passed`，退出码 0。新增控件测试直接执行实际提取 JS，覆盖非原生交互角色、onclick 属性、tabindex、隐藏节点和仅有 cursor 样式的诊断节点；威飒真实导航仍待复验。

## 12 续测：只读结构探针

用户回传零 refs 的 DOM 诊断：`ready_state=complete`、`scanned_nodes=716`、`visible_nodes=322`、`pointer_nodes=27`、`selector_candidates=14`、`visible_selector_candidates=0`。样本包括 `span.pod-subitem-label` 的“发货/财务”和 `div.pod-subbox-data` 等。这确认当前选择器没有命中可见候选，但不能证明这些普通节点实际绑定了事件，也不能证明 14 个候选的隐藏原因。

用户要求直接使用探针获取元素。已在零 refs 快照的 `DOM diagnostics.structure_probe` 中接入有界只读结构探针，仍走官方 Selenium 和原有 canonical 快照命令，不增加 CLI 契约或执行点击：

- 优先读取手形节点，补充短文本叶节点，最多 64 个目标；读取最多 40 个 selector 候选，包括隐藏候选。
- 对目标和最多 4 层父级输出共享 `nodes` 表，最多 160 个节点。返回标签、class、role、tabindex、计算样式、矩形、可见性阻碍，以及 DOM 事件属性和页面暴露的 Vue/React 事件函数存在性。
- 不执行事件函数，不读取函数正文、输入值、组件状态或认证信息。不能枚举任意事件委托和 `addEventListener`；没有线索不能推断没有事件。各预算有显式截断字段。
- `diagnostic_node` 和 `ancestors` 是当前 frame 内诊断表的索引，不是可点击 ref，不能传给 click/type。

本次 Codex 终端只检查了环境变量是否存在，结果 `LXE_AGENT_SESSION_ID absent`；没有复制或伪造会话，没有直接读取威飒页面。需要 LXE_Agent 的真实会话运行第 10 节同一条严格完整快照，并完整返回 `structure_probe`。真实页面探针结果尚未取得，不能声称已经找到导航事件绑定或查询成功。

定向验证从仓库根运行第 10 节同一组浏览器和相关 CLI 测试，结果 `115 passed`、退出码 0；其中 3 个新增测试执行真实提取 JS，验证父级事件线索、隐藏原因、优先级及截断，且不调用事件函数或框架 registry getter。

## 13 续测：识别 DOM onclick 函数

已只读核对用户提供的完整执行日志。诊断节点 42 是可见的 `li.pod-subitem`“发货”，矩形 `[120,0,80,50]`，存在 `dom_property:onclick`；节点 126 是 `a.submenu-item-div`“运单”，矩形及所列父级矩形均为零。用户提供的 HTML 明确了该链接为 `/tms/wos/shipment`。因此两个问题要分开：可见父菜单的 DOM onclick 函数漏进候选集，子菜单链接虽然命中原生选择器，却在该次快照时没有可见矩形。

用户明确要求修复。采集器现将原 CSS 候选与所有 document/开放 Shadow DOM 中 `typeof el.onclick === 'function'` 的节点合并去重，交互判定同步接纳该函数属性，输出 `detected_by=onclick_property`。只读取函数存在性，不执行它；仍过滤不可见控件，不把纯手形样式或子节点继承的手形样式视为交互证据，也不将非函数 onclick 值视为处理器。CSS 候选诊断计数保留原含义，并单独增加 DOM 属性候选计数。CLI 参数及 `catalog.json` 不变。

新增 14 项提取 JS 测试覆盖：非原生标签、无 onclick 属性/手形样式时的函数属性识别、非函数值拒绝、隐藏控件过滤、重复候选去重，以及模拟“发货”父节点和隐藏/显示的“运单”链接。用于探针本身的既有测试显式将元素预算设为零，以继续验证诊断输出，不依赖此次已修复的漏识别。

本轮没有操作真实页面。下一步由 LXE_Agent 在真实会话执行第 10 节的严格完整快照，核对“发货”的 `onclick_property` ref；菜单展开后必须重新快照取得“运单”的新 ref，不能拿诊断节点编号点击，也不能声称当前已完成展开或货件查询。

从仓库根执行第 10 节同一组浏览器及相关 CLI 定向回归，结果 `129 passed`、退出码 0；`git diff --check` 通过。未执行合并前全量验证，未合并到 `main`。

## 14 历史归档：实页已有 42 个 ref，查询当时待验证

用户在 `25efb1c2` 构建的 LXE_Agent 真实会话回传一次完整快照：`ok=true`、exit_code 0、无 error、`files=[]`。URL 为 `http://wsaexp.nextsls.com/tms/wos/home`，标题仍为威飒控制台，`Frames: (none found)`。返回 42 个 ref（`aid-0` 至 `aid-41`），全部 `frame=[]`、`detected_by=onclick_property`，未出现 refs 截断提示。

refs 覆盖顶部“发货/财务/更多/工具”、公司账户、账户卡片、运单进度和账单表行。历史快照中的“发货”为 `aid-1`，仅作证据记录，下一轮不得直接使用该旧 ref。此次仅证明修复后可见节点进入了交互候选；onclick 函数可能是框架代理或占位函数，是否实际展开菜单仍须动作后回读验证，不能将 ref 数量当作业务流程通过。

本轮没有 navigate/click/type/open_store/exit_store，没有展开菜单、输入 FBA、查询物流、改写订单或修改 Amazon。不存在已经取得的转单号或预计送达日期。已读取的账单不是目标货件查询结果。

### 下一轮固定上下文

- worktree：`/Users/lxe-3/LXE_AGENT/.worktrees/pool-1`；任务分支：`codex/fba-delivery-window`。代码及此前交接均已提交，尚未合并，不要释放此 worktree 或重新领取其他任务的 slot。
- 复用店铺：`VycOXC1cvUBC/rBIOnYXUg==`，`Amazon-Yunjian-US 深圳市久艺电子商务有限公司`；此前运行 browser_id 为 `16547398293641`，新一轮仍须实时核对。
- 威飒当前显示账户：`深圳市新棱镜贸易有限公司`。用户不确定对应关系，但已允许先在此账户查目标货件；若明确不对应，再核对另外账户。零结果本身不构成账户错误的证据。
- 目标：`FBA19PWM5L6T`，目的仓 `PSP3`，来源 `测试.xlsx / Sheet1!A2:P2`，发货单 `SP260911003`。
- 当前 Codex 终端此前没有 `LXE_AGENT_SESSION_ID`。真实页面命令必须在 LXE_Agent 实际会话执行，不得通过复制/伪造会话或读取 Bun agent DB 绕过。

### 下一轮步骤及停止条件

1. 按 `skills/ziniao-browser/SKILL.md` 先执行 `lxeskill browser store --action get_status`，核对指定店铺真实运行状态。页面命令始终带 `--strict-attach --target-host wsaexp.nextsls.com`，不允许启动/重启；实际错误即停。
2. 执行下面的新快照，核对当前 URL、标题、公司账户与最新“发货”ref。登录态失效时等用户完成登录，不索取密码或复制认证信息。
3. 用最新 ref 测试“发货”菜单是否展开，读取动作后的新快照，取得当前可见“运单”链接 ref 再进入。不猜 ref，不点击诊断编号，不把菜单展开成功当作货件查询成功。
4. 在运单页新快照中确认搜索字段含义，再输入完整 `FBA19PWM5L6T` 并查询。连续交互在已知 refs 范围内按技能合并为 `--steps`；未知的新页面 ref 必须先读取，不能跨页面预先编造。
5. 只有精确匹配货件后，才提取页面原文中的目的仓、转单号、承运人及查询时间。目的仓冲突、多个包裹、缺字段或零结果分别报告，不用 FBA 箱标或发货单替代转单号。
6. 再做一次独立读取，确认仍是同店铺、威飒标签和查询上下文。分别报告连接、登录账户、菜单/查询动作、业务匹配、转单号取得及重复读取稳定性。

```text
lxeskill browser page --action browser_snapshot --store-id 'VycOXC1cvUBC/rBIOnYXUg==' --strict-attach --target-host wsaexp.nextsls.com --full
```

本轮代码验证已完成：129 项定向测试通过。此次归档只更新交接文档，不重复运行代码未变化的测试；未运行合并前全量验证。下一轮先完成威飒单票，不扩展批量、其他物流商、尾程 ETA 或 Amazon 改期。

## 15 最新归档：威飒单票查询与转单提取通过

测试日期：2026-10-12。本轮浏览器命令由用户在 LXE_Agent 真实执行会话中运行并回传结果；Codex 读取本机生成的两张截图，与最终文本回读交叉核对。当前 Codex 终端仍不能直接执行页面命令：状态检查实际返回 `session_required` / `browser store requires an LXE session`，没有绕过会话限制。

### 已核实的唯一货件

| 字段 | 真实页面结果 |
| --- | --- |
| 紫鸟店铺 | `Amazon-Yunjian-US 深圳市久艺电子商务有限公司`，store_id `VycOXC1cvUBC/rBIOnYXUg==` |
| 威飒公司账户 | 深圳市新棱镜贸易有限公司 |
| 来源 | `测试.xlsx / Sheet1!A2:P2`，发货单 `SP260911003`，箱号 `1号箱` |
| FBA | `FBA19PWM5L6T`，精确匹配 |
| 威飒运单号 | `WS10026638` |
| 目的仓 | `PSP3`，与样表一致 |
| 渠道 | 空运-美国带电包税 |
| 平台、国家及邮编 | AMAZON、美国、92240 |
| 件数 | 页面原文 `1/1` |
| 尾程承运人 | UPS，来自页面“承运”列，不是按号码格式推断 |
| 转单号 | `1ZK1013D0321365378`，截图与文本一致 |
| 威飒状态 | 已签收 |
| 结果数量 | 共 1 条；已签收(1)、全部(1)，其余状态均为 0 |

该账户确实能查询到本票，但不能由此扩展为全部店铺与公司账户的长期归属映射。列表只展示一个转单号；尚未打开详情核验是否还有其他包裹或历史转单。页面没有提供已核实的尾程签收日期或 ETA，本轮未取得 CLI 精确查询时间，不把下单时间当作送达时间。

最终独立文本快照返回 `ok=true`、exit_code 0、无 error，未出现 refs 截断，约 68 个 ref，`Frames: (none found)`。输入框仍保留完整 FBA，唯一结果行包含上述运单、目的仓和 UPS 转单号。最终 URL：

```text
http://wsaexp.nextsls.com/tms/wos/shipment?page=1&pageSize=30&activeTab=delivered&keywords=FBA19PWM5L6T&isActiveTab=all
```

### 实测过程及验收边界

1. “发货”点击成功并展开菜单；跨调用点击历史“运单”ref 曾返回 `invalid ref: aid-42`，失败时菜单已收起。随后同一次 `--steps` 中展开“发货”并点击已观察过的“运单”链接，2/2 步通过，进入 `/tms/wos/shipment`。这一结果证明该批次导航成功，不证明菜单只能在同一次附着期间展开，也不授权预先编造新 ref。
2. 刚导航后的快照只见 6 个导航 ref，后续独立快照取得业务控件和列表。等待页面加载并回读是必要的，不能仅凭点击成功验收。
3. 点击查询类型时曾返回 `invalid ref: aid-50`，失败恢复快照已在 `/tms/wos/home`。用户说明两次调用之间只有快照与该点击命令。重新导航到已验证的运单地址后，独立快照及“关键字”点击成功，未复现跳回首页；原因未确定。
4. 切换“全部”成功，URL 显示 `activeTab=all`。使用最新快照确认的输入框写入 `FBA19PWM5L6T`，点击“搜索”，3/3 步通过，URL 出现 `keywords=FBA19PWM5L6T&isActiveTab=all`。
5. 搜索后的首份快照仍见非目标行，且存在截断；后续独立截图及最终独立文本快照均精确命中 1 条。初始非目标行的确切原因未证明，不能将其固定归因于异步渲染或截断。
6. 最终截图和文本均显示“已签收”选中，`activeTab=delivered`；用户没有报告两次调用间切换页签的动作。页签变化原因仍未确定，不能声称是已证实的网站自动行为。

连接、菜单导航、查询提交、精确业务匹配和转单号提取已有真实证据；最终独立回读保持同一账户、查询条件和结果。此前页面漂移未查明，因此不能宣布浏览器整体稳定性全部通过。本轮没有取得新的 `get_status` 成功结果或实时核对 browser_id；用户说明店铺一直未关闭，页面命令均严格附着成功，先前的 browser_id 不冒充本轮实时结果。

### 工具使用中已确认的问题

- ref 随 DOM 节点重建或导航变化；同一页面不变时也曾跨调用保持一致。只能使用最新观察且明确匹配目标的 ref，不能宣称“跨调用一定失效”，也不能依赖历史编号。已授权查询范围内，按新快照明确匹配的字段更新 ref 无需重复征求同意。
- `browser_snapshot --full` 采集上限为 200 个 ref，文字摘要最多展示 80 个，正文也会截断。看不到目标不等于不存在；不能构造尚未支持的“只看表格区域”参数。
- `browser_vision --full` 实测返回 exit_code 4、`invalid_arguments`、`browser_vision only accepts store_id`。去掉 `--full` 并保留严格附着参数后截图成功。已只读核对 schema：`strict_attach`、`target_host` 是允许的会话参数，`full` 不在截图参数中。`skills/ziniao-browser/SKILL.md` 声称截图可带 `--full`，与实现不一致；本轮只归档，未修正文档或代码。
- 当前 DeepSeek 会话读取 PNG 返回 `[image omitted: the selected model does not support image content]`，无法视觉判断；Codex 已实际查看本机图片。无需把“允许截图”或“允许读取已生成截图”再次作为用户审批项。
- 批处理以 `browser_vision` 收尾时，本次返回没有保留前一步完整 refs 正文。截图后需要 refs 或文字证据时，单独执行 `browser_snapshot --full`；成功退出不代表所有中间快照均完整返回。
- 批内步骤失败时曾出现 exit_code 0，但正文明确报告停止和 `invalid ref`。验收必须检查每步结果及业务回读，不能只检查进程退出码或顶层 `ok`。

本轮实际成功的截图命令为：

```text
lxeskill browser page --action browser_vision --store-id 'VycOXC1cvUBC/rBIOnYXUg==' --strict-attach --target-host wsaexp.nextsls.com
```

### 页面证据及下一轮边界

已实际读取的本地截图路径如下；文件在忽略的运行时产物目录，未加入 Git，后续清理运行时目录可能移除它们。关键结果已记录在本节，不依赖截图长期存在：

- 查询前页面：`/Users/lxe-3/LXE_AGENT/.worktrees/pool-1/var/workspace/.lxeagent/artifacts/browser/amazon_store_agent/8d7d3cbb69c74af18e907d82859d5083/agent-1791795163.png`。
- 唯一命中结果：`/Users/lxe-3/LXE_AGENT/.worktrees/pool-1/var/workspace/.lxeagent/artifacts/browser/amazon_store_agent/8d7d3cbb69c74af18e907d82859d5083/agent-1791795685.png`。

威飒首轮单票阶段已收尾。本轮未查询 UPS、未取得尾程实际签收日期或 ETA、未修改物流订单或 Amazon、未改写原始表格，未启动、重启或退出店铺。下一轮按用户要求选择尾程只读核验或浏览器稳定性排查；这票威飒状态已签收，不直接生成改期建议，不扩展批量或其他物流商。所有实际页面命令继续走 LXE_Agent 真实会话及官方配对 Selenium 链路，禁止复制或伪造会话。

此次归档只修改本交接文档，代码及 `catalog.json` 不变；129 项定向测试是此前代码验证结果，本轮不重复运行。未运行合并前全量验证、未合并 `main`，保留当前任务分支和 worktree。
