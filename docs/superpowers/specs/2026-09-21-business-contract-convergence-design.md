# 四平台业务 Contract 收敛设计

## 背景

雅仓、智慧印尼、智汇 TMS 和马帮巴西海外仓已经各自具备导出能力，但当前实现没有在同一边界上统一“自然语言理解、结构化参数、执行结果和结束条件”。实际运行出现了以下问题：

- 雅仓模型调用曾传入 `value`，而 catalog 和 parser 只接受 `values`，导致第一次调用失败后重试；
- “越南仓入库/上架时间”在意图层保留越南仓，执行层却固定执行全局任务；
- 马帮“未签收”等同义表达没有完整、唯一的 canonical intent；
- 智汇 TMS 在普通 Agent 之前运行平台专用 pre-turn 和额外模型翻译；
- 四条业务返回的 `data` 形状和错误码不统一，成功生成文件后模型仍可能继续判断或调用工具；
- 智慧印尼验证码依赖平台专用 Tool，但现有通用问题卡还不能展示图片并承载一次性 challenge。

本设计收敛现有能力，不新增总路由、总 Skill 或平台专用全局前置判断。

## 目标

1. 用户表达在进入业务命令前只有一个 canonical intent。
2. `SKILL.md`、catalog schema、normalizer、测试和 terminal result 使用同一口径。
3. 雅仓库存和销量同时支持单仓、任意多仓和默认四仓。
4. 雅仓入库/上架只执行一次全局导出，结果覆盖四仓，不拆成四份。
5. 成功文件任务返回明确的 `ok=true` 和 `files`；失败保留真实、脱敏、可行动的业务错误码。
6. 智汇 TMS 回归普通 Agent → Skill → CLI 链路，移除主链前的额外模型调用。
7. 智慧印尼验证码能力不丢失，但不再保留平台专用模型 Tool；验证码并入现有通用用户输入机制。
8. Runtime 中平台专用分支数量净减少，不以新增兼容层、关键词路由或并行旧链路换取短期可用。

## 非目标

- 不新建所谓 LLM Router。
- 不新建四平台总 Skill 或总 workflow-map。
- 不新建 Mabang Brazil 顶层 Skill。
- 不修改四个平台的生产 API、账号、凭据、限速或风控策略。
- 不把雅仓全局入库/上架导出伪装成四次分仓导出。
- 不修改无关 Skill 或批量重构 Runtime。
- 不新建第二套问题卡、会话等待或敏感输入框架。
- 不为了兼容旧行为长期保留新旧两条生产调用链。

## 复杂度预算

本次整改必须做净减法。完成后满足：

- Runtime 不出现 `yacang`、`zhihui`、`shangman`、`mabang` 平台名驱动的 pre-turn 分支；
- 普通 Turn 和四平台 Turn 都只进入一次普通 Agent Provider 链路，不额外调用平台专用意图模型；
- ToolRegistry 不再注册 `shangman_captcha` 这类平台命名 Tool；
- 验证码复用现有 `ask_user_question` 与问题卡基础设施，只扩展一种通用、敏感、可带图片的 pending input 形态；
- 每个平台只保留自己的 Skill、catalog contract 和 agent-cli adapter，不新建跨平台业务编排层；
- 旧智汇 translator、confirmation router、Runtime option 和装配代码在新链路测试通过后删除，不保留影子入口；
- 雅仓旧 `request_text` 只允许内部兼容测试或预览入口使用，不允许新生产 Skill 路径回退到关键词 parser。

## 统一链路

四条业务采用同一职责划分：

```text
Available Skills
→ 模型选择业务 Skill
→ 模型按 Skill 生成结构化参数
→ catalog 校验参数形状
→ 业务 normalizer 校验枚举、默认值和组合规则
→ handler 执行现有工作流
→ lxeskill 输出统一 terminal result
→ files 非空时发送文件并结束
```

模型负责把自然语言翻译成受限结构；业务代码负责确定性校验和执行，不在 Runtime 主链增加平台关键词路由。

## 雅仓 Contract

### 固定仓库集合

雅仓仓库集合和顺序固定为：

```text
MY8801  马来西亚仓
PH8805  菲律宾仓
TH8802  泰国仓
VN8806  越南仓
```

仓库列表只能来自同一个业务常量，Skill、catalog 和测试不得各自维护不同顺序。

### 库存和销量

`inventory-sales` 与 `inventory-current-snapshot` 使用相同仓库选择规则：

- `warehouse_intent.state=omitted`：执行四仓；
- `warehouse_intent.state=resolved` 且一个 `values`：执行单仓；
- `warehouse_intent.state=resolved` 且多个 `values`：按固定四仓顺序执行所选多仓；
- 空数组、重复仓库、未知仓库：校验失败；
- `ambiguous`：返回澄清问题，不执行生产请求。

结构化输入只允许复数数组：

```json
{
  "data_type_intent": {"state": "resolved", "values": ["inventory-sales"]},
  "warehouse_intent": {"state": "resolved", "values": ["MY8801", "VN8806"]},
  "created_date_filter": {"state": "omitted"},
  "inventory_snapshot_intent": {"state": "omitted"}
}
```

单仓也必须使用单元素 `values`，不再出现 `value` 与 `values` 两种写法。

库存动销多仓结果继续合并成一个 XLSX；当前库存沿用现有交付策略，但 terminal 必须明确实际执行的仓库集合。默认四仓测试必须同时覆盖库存动销和当前库存。

### 入库和上架时间

`inbound-listing-time` 是一次全局任务：

```json
{
  "task_id": "inbound-listing-time:global",
  "scope": "global",
  "warehouse_scope": "all"
}
```

规则如下：

- 单独查询入库/上架时，无论用户是否提到单仓或多仓，canonical effective scope 都是 `global/all`；
- global/all 明确表示该文件覆盖四仓，不表示执行四次，也不生成四份文件；
- 入库/上架的任务参数中不传仓库；
- 若同一请求同时包含库存或销量，仓库选择只约束库存/销量任务，入库/上架仍保持一次 global/all；
- terminal 和用户回复必须说明“入库/上架为覆盖四仓的全局文件”，避免把单仓措辞继续带到交付结果。

为消除当前冲突，inbound-only 请求在 normalizer 中把 effective warehouse scope 规范化为 `all`，不再保留一个会被执行器忽略的单仓 effective 值。原始用户表达仍由会话消息保留，不进入执行参数。

## 马帮巴西海外仓 Contract

继续使用现有 `replenishment-workflow-map` 和 `replenish brazil-overseas export`，不增加顶层 Skill。

canonical intent 固定为：

| 用户表达 | `export_kind` |
| --- | --- |
| 库存、销量、库存动销 | `inventory_sales_snapshot` |
| 单据、调拨单据，未指定签收状态 | `allocation_both` |
| 未签、未签收、待签、待签收、还没签收、尚未签收 | `allocation_pending_default_3m` |
| 已签、已签收、已经签收、签收完成 | `allocation_signed_before_3m` |

只有无法判断签收状态的表达才返回澄清。Skill、catalog 描述和参数测试必须包含完整同义词集合；业务 normalizer 继续只接受 canonical enum，不引入 Runtime 全局关键词过滤。

## 智慧印尼 Contract

智慧印尼继续使用结构化 `params`：

```json
{
  "platform": "智慧",
  "country": "印尼",
  "operation": "goods_export",
  "requested_metrics": ["inventory"],
  "sales_windows_days": []
}
```

`sales`、`inventory`、`inbound_time` 和 `listing_time` 都映射到现有商品原始导出，不宣称平台文件包含未实际提供的历史字段。

现有通用 `ask_user_question` 只能处理文本和选项，尚不具备以下等价能力：

- 展示验证码图片；
- 绑定当前 session/turn 的一次性 challenge；
- 将输入安全回传给等待中的 Python 导出；
- 防止验证码内容进入 transcript 和命令参数。

本次在同一套用户问题基础设施中增加通用 pending input 形态，不新建另一套业务交互框架：

```ts
type PendingSensitiveInput = {
  request_id: string;
  kind: "image_text";
  prompt: string;
  image_data_url: string;
  sensitive: true;
};
```

通用化后的边界如下：

- Python 业务通过本机一次性通道创建 pending input，只得到不透明 `request_id`；
- Dashboard 使用现有问题区域显示图片和输入框；
- 用户输入只进入内存 broker，并由等待中的 Python 请求消费；
- transcript、工具参数、terminal data 和日志只记录 `accepted` 与 `request_id`，不记录图片正文或用户输入；
- `ask_user_question` 增加“等待已有 pending input”的通用模式，模型不创建图片、不接触验证码内容；
- 原 `sessions.shangman_captcha.answer` RPC 改为平台无关的 pending-input answer RPC；
- 原 `shangman_captcha` Tool、平台专用 Dashboard 字段和平台专用 channel 环境变量在迁移测试通过后删除。

这个通用输入能力只解决“展示现有 challenge 并等待敏感文本”这一件事，不扩展成通用工作流引擎。以后其他平台遇到同类人工输入时复用该能力，不再复制 Tool。

## 智汇 TMS Contract

智汇 TMS 不再在所有桌面 Turn 前调用 `tryRunZhihuiConfirmation` 和额外 Provider 翻译器。普通 Agent 根据 Available Skills 选择 `zhihui-tms-product-export`。

公开 CLI 改为结构化参数，不再依赖宽松的原始 `request` 关键词判断：

```json
{
  "action": "preview",
  "platform": "zhihui_tms",
  "warehouse": "PH",
  "intent": "product_export",
  "fields": ["inventory"]
}
```

规则如下：

- `platform` 只能是 `zhihui_tms`；
- `warehouse` 只能是 `PH`；
- `intent` 只能是 `product_export`；
- `fields` 只能包含 `product`、`sku`、`sales`、`inventory`、`inbound`、`listing`，至少一个且不能重复；
- 只说“菲律宾库存”时 Skill 必须澄清平台，不能直接调用智汇命令；
- 明确“雅仓菲律宾仓”“智慧印尼”或“马帮巴西”时不得选择智汇 Skill。

确认流程迁回普通 Agent：先执行 `preview`，再使用通用 `ask_user_question` 展示“确认执行导出/取消”，只有本次问题卡明确确认后才执行 `action=execute`。普通聊天中的“执行”不能复用旧确认，也不能绕过问题卡。

现有登录、分页、账号锁、进度事件、部分文件交付、403/429 停止和错误脱敏保持不变。智汇专用 progress formatter 可以继续作为命令执行后的展示适配，它不参与 Skill 选择，也不增加 pre-turn 模型调用。

删除范围包括：

- `tryRunZhihuiConfirmation`；
- `ProviderZhihuiParameterTranslator` 与平台关键词正则；
- `zhihuiConfirmation` Runtime option；
- Runtime Host 中的智汇专用 router/translator 装配；
- 被新普通 Agent 链路替代的智汇专用确认路由测试和文档。

这些删除只发生在结构化 CLI、通用问题卡确认和部分文件交付测试全部通过之后。

## Terminal Result Contract

### 统一外层

所有命令继续由 `lxeskill` 输出唯一终态记录：

```json
{
  "protocol_version": "1",
  "type": "result",
  "command": "...",
  "ok": true,
  "data": {},
  "files": []
}
```

外层语义固定：

- `ok=true` 表示命令已成功完成；
- `ok=false` 必须包含 `error.code` 和脱敏后的 `error.message`；
- `files` 只包含经过 artifact root 校验的最终可交付文件；
- 失败时只有明确允许交付的部分文件才能出现在 `files`；
- `recovery` 只描述一个允许的下一步，不触发无限重试。

### 紧凑业务数据

四条业务的 agent-cli adapter 负责把内部工作流结果投影成紧凑 terminal data。内部 planner、task 和 HTTP 诊断可以保留在内部对象、事件和测试中，但不把完整内容全部送回模型。

成功 `data` 只保留：

- `platform`；
- `business_type`；
- `scope`；
- 实际仓库集合或 `warehouse_scope=all`；
- `row_count` 或必要的部分成功计数；
- 能区分完整成功、部分成功的业务状态。

失败 `data` 只保留恢复判断真正需要的上下文，例如 `auth_refresh_required`、部分页数和部分行数。不得重复返回整份 `params`、`intent`、`plan`、完整 headers、原始平台 Response 或调试日志。

通用 `_finalize_payload` 必须优先保留业务错误码：

1. `payload.error.code`；
2. `payload.code`；
3. 无业务错误码时才使用 `business_cli_failed`。

错误消息仍遵守真实错误和脱敏要求。

### 文件任务结束条件

当 terminal 满足：

```text
ok=true
且 files 非空
```

普通 Agent 只执行一次文件发送，然后给出简短交付说明并结束。不得继续读取其他 Skill、检查历史文件、搜索 transcript 或启动同类导出。用户明确要求后续分析时才进入新步骤。

该结束条件通过紧凑 terminal、Skill 规则和 Runtime fixture 行为测试共同保证，不增加“成功后再调用一个结束判断模型”或平台专用 post-filter。

## 导出准确性保护

本次不重写四个平台的 HTTP、登录、分页、下载、XLS/XLSX 校验或雅仓多仓合并算法。调整发生在执行前的结构化 contract 和执行后的 terminal adapter，底层导出实现保持原样。

准确性由以下测试固定：

- 雅仓 planner 精确断言每个单仓、多仓、四仓请求产生的仓库任务集合和固定顺序；
- 雅仓 global inbound 精确断言只有一个任务、没有仓库参数、`warehouse_scope=all`；
- fixture executor 精确断言传给现有导出实现的仓库、数据类型和日期参数；
- XLS/XLSX fixture 验证文件存在、可打开、表头符合现有平台真实导出结构，并核对行数与 terminal `row_count`；
- 多仓合并验证仓库列只包含所选仓库，默认查询必须同时包含四个仓库；
- 智慧、智汇、马帮保留现有真实响应 fixture 和下载校验测试，不用合成成功结果替代平台响应；
- terminal adapter 只做摘要和路径投影，不能修改已生成文件；
- 生产门禁关闭时只运行 preview/fixture，不用真实账号做回归探测。

## 错误处理与安全

- schema 形状错误在发起生产请求前失败，并返回具体字段错误；
- `ambiguous` 意图只返回澄清，不执行远程调用；
- 401 按现有授权恢复规则处理；403、429、验证码异常、导出状态未知或明显风控立即停止；
- 不自动开启生产门禁，不从错误文本猜凭据或平台参数；
- Token、Cookie、账号、密码、验证码和 challenge channel token 不进入 terminal data、日志或 Git；
- 成功与 `pending/processing/continue` 状态不得同时出现。

## 测试策略

### 雅仓

- 单仓库存、单仓销量；
- 两仓和三仓的库存、销量；
- 省略仓库时库存和销量均覆盖固定四仓顺序；
- 单仓、多仓、四仓措辞的入库/上架均只生成一个 global/all 任务；
- 混合请求中库存/销量按所选仓执行，入库/上架仍只生成一个 global/all 任务；
- `value` 形状失败，`values` 单元素和多元素通过；
- 成功 terminal 的仓库范围、文件数量和紧凑字段正确。

### 马帮巴西

- 四个未签收同义词组统一映射 pending；
- 已签收同义词组统一映射 signed；
- 单据未指定状态映射 both；
- 模糊表达触发澄清；
- 成功和失败 terminal 保留具体业务错误码。

### 智慧印尼

- 结构化参数继续通过 schema 和 normalizer；
- 验证码 required、accepted、expired、channel unavailable 行为不变；
- 通用 pending input 可以显示图片、等待敏感文本且 transcript 中不出现输入内容；
- ToolRegistry 中不再存在 `shangman_captcha`；
- 其他 Skill 可以复用 pending input 类型而无需新增 Tool；
- terminal 成功不再返回完整 params/intent/plan/headers；
- 没有文件时不得宣称完成。

### 智汇 TMS

- 普通请求不发生额外 pre-turn Provider 调用；
- 智汇请求本身也不发生第二次平台专用 Provider 翻译调用；
- 明确智汇请求由普通 Skill 路径暴露并读取 Skill；
- 结构化字段白名单校验；
- preview → 通用问题卡 → execute 的确认边界；
- 取消、非法参数、preview 失败均不执行生产调用；
- 部分文件、403、429 和脱敏错误行为保持不变。

### 双端契约与回归

- catalog 修改同时运行 Python catalog/infra 测试和 Bun `lxeskill-command` 测试；
- Runtime 定向测试验证删除智汇 pre-turn 后普通 Agent 路径不回归；
- 运行四条业务的受控成功/失败 fixture，记录 terminal 大小；
- `git diff --check`、敏感信息扫描和工作区状态检查作为结束门槛。

## 实施顺序

1. 先补失败测试，固定雅仓四仓、单仓、多仓和 global inbound 语义。
2. 对齐雅仓 Skill、catalog、normalizer、planner 和 terminal data。
3. 补齐马帮 canonical 同义词和测试。
4. 引入紧凑 terminal data 与业务错误码保留规则，逐条迁移四个 adapter。
5. 在现有用户问题基础设施中加入通用敏感图片输入，并迁移智慧验证码。
6. 删除平台专用 `shangman_captcha` Tool、RPC 字段和 channel 命名。
7. 将智汇 CLI 改为结构化参数并建立普通 Agent 确认链路。
8. 在回归测试覆盖后删除智汇 pre-turn、translator 和专用确认装配。
9. 运行定向验证、契约双端验证、复杂度扫描和最终安全检查。

## 验收标准

- 雅仓库存和销量对单仓、任意多仓、默认四仓均有确定且测试覆盖的执行计划；
- 雅仓入库/上架无论用户提几个仓，都只产生一个覆盖四仓的 global 文件；
- 结构化调用不再因 `value/values` 歧义先失败再重试；
- 马帮未签收和已签收同义词只有一个 canonical enum；
- 普通桌面 Turn 不再经过智汇专用 pre-turn 或额外翻译模型；
- 智汇仍必须通过通用问题卡显式确认后才能执行生产导出；
- 智慧验证码能力保持可用，ToolRegistry 中不存在平台专用验证码 Tool；
- 四条业务成功 terminal 都有明确 `ok=true` 和有效 `files`，失败 terminal 保留具体业务错误码；
- 成功文件任务发送文件后结束，不再进行无关检查或工具调用。
- Runtime 不包含四个平台的关键词 pre-filter，平台业务增加不会要求修改全局 Turn 入口。
