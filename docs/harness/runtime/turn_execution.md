# Runtime 执行流程

本文集中说明一条任务从入口到结果交付的流程，以及 turn、step、工具、取消和持久化的关系。执行事实以 [`runtime.ts`](../../../packages/agent/runtime/src/engine/runtime.ts) 与对应测试为准；Context、工具和存储的细节分别由其专题维护。

## 端到端链路

```text
桌面 preload IPC / FeishuAdapter
  -> SessionRouter：权限、会话绑定、response route
  -> SessionScheduler：排队、RunHandle、取消
  -> agent-cli / AgentRuntimeHost：JSON-RPC 2.0
  -> TypeScriptAgentRuntime.runTurn()
  -> ContextPipeline -> Provider -> ToolRegistry -> 下一 step
  -> TurnOutcome -> GatewayEmitter -> 桌面展示 / 飞书消息与文件
```

Gateway 位于 Electron Main，Runtime 位于独立的 `agent-cli` 子进程。两者使用 JSON-RPC 2.0、stdin/stdout 和 JSONL 分帧；握手、通知和错误规则见 [Agent 协议](../../desktop/gateway/agent-protocol.md)。Gateway 负责接入、调度和发送位置，Runtime 负责模型与工具执行。

进程装配、启停与失败回滚见 [Gateway 与 Agent 生命周期](../../desktop/gateway/gateway_lifecycle.md)。

## Turn 建立与快照

Router 校验权限、建立 session、保存 response route 后创建 `AgentJob`；Scheduler 创建 `RunHandle`。Runtime 读取自己的 session，校验 WorkspaceContext 并取得 Workspace Lease。本轮固定模型配置、system prompt、允许的 Skill 元数据、上下文窗口以及 session、route、turn 标识。同一 Lease 的指令与搜索服务贯穿整个 turn；凭据解析与模型快照见 [模型目录](../llm/provider_catalog.md#选择与生效)。

Dashboard 修改模型、thinking 或技能配置不会改写已开始的快照；provider 切换从下一 turn 生效。turn 内的工具暴露可以影响后续 step，每次工具调用仍按当前会话权限检查。

Runtime 加载会话历史，再追加本轮用户输入。入口诊断独立放在 `AgentJob.diagnostics`；Runtime 通过 [`withTurnContext()`](../../../packages/agent/runtime/src/engine/system-events.ts) 把诊断说明合入本轮 user message 后持久化，字段值始终作为数据处理。

用户消息及之后每条有效 steering 都作为独立 user message 追加，保证 replay 与执行时的顺序一致。飞书普通 turn best-effort 设置 typing；桌面、飞书和 CLI 按响应路由创建 `FinalAnswerStreamer`，并初始化 turn/tool/skill usage；本轮用量只结算一次。

宿主通过 `runtime.on(name, (event, ctx) => ...)` 订阅 Runtime 实例的事件，调用返回的函数即可取消本次订阅。Runtime 按注册顺序逐个等待处理函数完成。如果某个订阅者抛错，Runtime 记录实际错误并继续。`ctx` 提供当前的 `sessionId`、`turnId`、工作区、平台和取消信号。

- `before_turn` 在组装本轮初始提示词与工具清单前触发一次，`event.userInput` 是本轮提交的文本。
- `before_model_step` 在每个模型步骤触发一次，`event.step` 从 0 开始。同一步内的供应商重试沿用该步骤。MCP 宿主订阅此事件检查外部登录凭据，按需完成重连后，Runtime 才获取本次请求的目录与工具清单。

## Step 固定顺序

一次 turn 包含从任务输入到完成、取消或失败的整个执行过程，可以经历多个 step、多次上下文组装和按需压缩。Step 是一次模型请求及其工具结果的处理周期：

1. 检查 abort，消费 steering 并追加用户消息，然后等待 `before_model_step` 的订阅者执行完毕。
2. 捕获本 step 可见的工具 schemas，预算估算与模型请求使用同一份 schemas。
3. `ContextPipeline.prepare()` 归一化内容、修复工具闭合，估算 system、messages、tools 和 image 的完整预算，必要时压缩。
4. Provider 请求与重试，流式输出 text、thinking、redacted thinking 计数、tool use 和 usage。
5. 完整 assistant response 先追加到 transcript。
6. 无工具调用时检查是否有待处理的 steering：符合继续条件则追加输入并进入下一 step，否则进入 final；有工具调用时按顺序执行相邻的并行组或独占调用。
7. 结果按原调用顺序组成 tool message 追加，再进入下一 step。

Context 的软阈值、硬上限和安全压缩规则见 [Context](context/README.md)；prepare 失败不能用本地伪摘要替代实际失败。只有安全压缩成功才追加相应 `context_patch`。

assistant 先落盘，再执行工具；进程在工具执行中退出时，replay 可以识别未闭合调用并补 unavailable 结果。没有工具调用且无需处理 steering 的响应，即使正文为空也会结束。

## Provider 与流式输出

普通请求最多尝试 3 次（含首次），step number 不变，仅增加 attempt。可重试的错误在约 1 秒、2 秒的指数退避基础上增加随机等待；等待可以取消。供应商给出 `Retry-After` 或 `retry-after-ms` 时，不能比它要求的时间更早重试；超过 60 秒等待上限则停止本轮自动重试，保留原错误和要求的等待时间。SDK 自身重试关闭，避免叠加预算。摘要沿用自己的次数和退避预算，也遵守服务端最短等待时间与 60 秒上限。

OpenAI 同时检查 HTTP 状态与 `error.code/type`：暂时限流、过载和连接故障可重试；认证、权限、参数、额度或消费上限错误不重试。`content_filter` 等未完成原因按实际原因报错，`max_output_tokens` 单独记为 `length`。分类依据见 [OpenAI 官方错误说明](https://developers.openai.com/api/docs/guides/error-codes)，实现见 [错误分类](../../../packages/agent/runtime/src/providers/provider-errors.ts) 和 [重试等待](../../../packages/agent/runtime/src/providers/provider-retry.ts)。

界面、会话错误记录和最终回复展示供应商的实际错误正文、错误码、HTTP 状态、可用的 request ID 及网络底层原因，只做必要脱敏与显式截断。分类标签用来决定恢复动作，不替代错误正文；摘要压缩失败同样保留具体的供应商原因。

流式失败继续采用 Pi 式恢复：已收到的半截回复留在 transcript，下一次请求排除该失败消息；可重试错误等待后重新请求，不接着半截正文拼接，也不重跑此前步骤已完成的工具。手动停止不自动重试。

context overflow 独立走一次强制 compaction；压缩成功且预算回到硬上限内，才允许再次请求。重复 overflow 或压缩失败终止 turn，不继续消耗普通重试预算。

`FinalAnswerStreamer` 节流展示更新，维护同一 emit id 和单调 sequence。完整响应成为可回放的 assistant message；失败或停止时，已收到的内容以 `error` / `aborted` 状态保存，仅供历史展示。thinking signature 和加密块可保留在模型历史，平台展示和日志只接收各自允许的内容。

## 工具执行与暴露

`ToolExposureState` 在 turn 内持续存在：direct 工具按来源和权限过滤；deferred 工具通过 `tool_search` 暴露；读取当前允许的 `SKILL.md` 激活 owner tools。新增暴露从下一 step 的 schema capture 生效，不能让模型在同一 response 中调用此前未提供的工具。

每个调用都检查 steering/cancel、exposure 与 input 边界，记录开始状态，再执行 handler。工具 context 携带 handle、session、route、turn 和 exposure。返回的 state patch 先应用、artifact 先发送，再将 model-visible result 加入本批结果，记录耗时、usage 和展示终态。

工具异常形成 `is_error` 结果，不跳过闭合；后续调用继续按当前策略执行，除非 steering 或 cancel 中断计划。相邻且支持并行的调用成组执行，其余独占，结果始终按原调用顺序持久化。

`exec` 按通用权限与进程规则执行外部命令。项目集成会注入 `LXESKILL_SKILL_SCOPE`，lxeskillCLI 自行处理授权、参数和业务执行。统计观察独立于工具执行，通过公开 CLI 查询命令归属，不加载业务 Catalog。详见 [工具手册](tools/README.md) 与 [Skill 手册](../skill/README.md)。

## Steering 与取消

工具 dispatch 前发现 steering 时，当前及剩余未执行调用写 skipped/error 结果。Runtime 先闭合这批工具，再追加 steering，开始下一 step；已完成工具不重跑，已发送 artifact 不撤回。

`RunHandle` 的 signal 中断 provider、summary、MCP、问题等待和当前 exec/wait 观察。未执行调用写 cancelled 结果，取消后的 step 不再调用 provider。剩余 steering 由 Scheduler 按 run 状态处理；命令进程与观察的生命周期见 [工具手册](tools/README.md#cancel-与-exec-生命周期)。

`ask_user_question` 只对本轮来自桌面的任务开放，独占等待专用答案，不额外请求模型；普通 steering 不能解除问题等待。

## Cancel 与失败

桌面停止按钮、提问卡片 × 和渠道 `/stop` 使用 `cancel_turn.reason: "user_stop"` 标记主动停止。Runtime 确认 cancelled 后，在完成通知之前追加一次独立 user 消息，绑定原 turn，transcript 的 `reason` 为 `turn_aborted`：

```text
<turn_aborted>
The user interrupted the previous turn. A tool or command may have run partially. Check its current state before continuing.
</turn_aborted>
```

说明保留在模型历史和原始 transcript 中，桌面依据可信的 `source_reason` 隐藏，只显示“已停止”；不按用户文字过滤，也不拼到下一条用户消息。旧历史不改写。重复停止、旧回合请求、已完成回合、仅清空队列，以及重启、关闭和凭据更新等技术取消均不新增说明。写入失败保留实际错误，取消仍然有效。Gateway 负责清理待执行队列。

错误真实性与脱敏要求统一见 [AGENTS.md](../../../AGENTS.md#红线违反--生产事故) 和 [日志与诊断](../../logging.md)。

Runtime 以 `completed`、`cancelled` 或 `error` 结束，Scheduler 释放 active slot。provider/context/Runtime 的终止性错误关闭本轮；单个工具或 delivery 失败不得使 Bun 进程退出，错误处理也不能拖垮 Gateway。

## Final 与步骤上限

默认不限 step 数，直到自然结束、取消或终止性错误。只有显式设置有限的 `maxSteps` 时，最后一步禁用工具并收尾；若模型仍返回工具调用，不执行，优先使用响应正文，无正文时提示发送下一条消息继续，transcript 仍保持闭合。

正常 final 完成同一条流式回复；只有此前未成功发送 stream frame 时才尝试普通 final emit。随后执行 post-turn context maintenance；它可追加 compaction `context_patch`，失败只记录 warning，不撤销已交付结果。异常或取消也必须关闭 streamer、typing 和 usage。

平台 delivery 是独立边界，发送失败不回滚已持久化 outcome，也不重放工具。

## 持久化与排障

- Gateway 保存 response route 与平台绑定；Runtime 保存 Agent session、usage 和 transcript 索引；lxeskillCLI 管理自身业务数据与配置。文件布局见 [本地数据与存储](../../storage/README.md)。
- Transcript v3 追加 message、turn metadata 和最小 `context_patch`，不回写旧行。模型 replay 与完整审计展示共享来源，规则见 [Context Persistence](context/context_persistence.md)。
- 原始 transcript 保留图片内容；模型视图可因压缩而缩短，展示和供应商请求可以采用各自的图片投影，不能将这些投影视为原图已被删除。详见 [图片持久化](context/context_persistence.md#图片与敏感数据)。
- turn、provider attempt、tool、context、usage 和 delivery 的关联字段、事件与脱敏统一见 [日志与诊断](../../logging.md)。
