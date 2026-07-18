# Runtime Flow

状态：Current

## 目的

本专题给出一次用户消息从平台 ingress 到最终 CardKit/file delivery 的端到端地图，并说明每层拥有的状态。需要定位“消息在哪一步丢失”“谁负责 cancel”“工具结果何时持久化”时，应先从这里确定边界，再进入专题文档。

## 主链路

```text
Feishu event
  -> FeishuAdapter / InboundEvent
  -> SessionRouter / permission + binding + route
  -> SessionScheduler / RunHandle
  -> AgentRuntimeHost / NDJSON host boundary
  -> TypeScriptAgentRuntime.runTurn()
  -> ContextPipeline.prepare()
  -> RuntimeProvider.turn()
  -> ToolRegistry.execute()
  -> TurnOutcome
  -> GatewayEmitter
  -> Feishu CardKit / message / file
```

Gateway 位于 Electron Main，Runtime 位于 Electron 管理的私有 `agent-cli` 子进程；两者通过版本化 agent protocol 通信。平台 callback、session 排队和 turn 执行仍以接口隔离职责。

## 边界地图

| 边界 | 状态与职责 | 当前实现 |
| --- | --- | --- |
| Bootstrap | 桌面配置、policy、store、受管 Runtime、channels | [`desktop-gateway.ts`](/apps/desktop/src/main/desktop-gateway.ts) |
| Inbound | 飞书事件、资源与统一消息 | [`feishu/inbound.ts`](/apps/gateway/src/channels/feishu/inbound.ts) |
| Routing | 权限、binding、route、控制命令 | [`router.ts`](/apps/gateway/src/orchestration/router.ts) |
| Scheduling | queue、active run、abort、steering | [`scheduler.ts`](/apps/gateway/src/orchestration/scheduler.ts) |
| Agent Host | Store、Provider、Runtime、MCP、Python CLI、Workspace、tools、Dashboard 装配 | [`runtime-host.ts`](/apps/agent-cli/src/runtime-host.ts) |
| Turn | provider/context/tool loop 与 outcome | [`runtime.ts`](/packages/agent/runtime/src/engine/runtime.ts) |
| Context | canonical history、预算与 compaction | [`context.ts`](/packages/agent/runtime/src/engine/context.ts) |
| Provider | catalog、SDK stream、retry、usage | [`provider.ts`](/packages/agent/runtime/src/providers/provider.ts) |
| Tools | native、MCP、script、skill exposure | [`tools.ts`](/packages/agent/runtime/src/tooling/registry.ts) |
| Storage | session、route、JSONL、usage | [`storage.ts`](/packages/agent/runtime/src/state/storage.ts) |
| Outbound | emit validation、route resolution、platform action | [`emitter.ts`](/apps/gateway/src/channels/emitter.ts) |

## Turn 建立

Router ensure/rebind session，保存 response route，并把 pending events 与当前用户输入组成 `AgentJob`。Scheduler 创建 `RunHandle` 后，Runtime 读取 session、验证不可变 WorkspaceContext、取得 Workspace Lease，再固定 provider generation、exposure state、system prompt、trace 和可选 `FinalAnswerStreamer`。同一 Lease 的 Skill、AGENTS Instructions 和搜索服务贯穿整个 Turn。

用户消息立即 append 到 transcript。之后每个 steering 也以独立 user message 持久化，确保进程退出后 replay 与模型实际看见的顺序一致。

## Step 循环

每个 step 顺序固定：

1. 检查 abort 并消费 steering。
2. 获取当前 exposure schemas。
3. ContextPipeline 修复 message closure、裁剪新 tool result、估算完整请求并按需压缩。
4. Provider streaming 产出 thinking/text/redacted/tool-use 和 usage。
5. assistant content 先 append transcript。
6. 没有 tool use 时进入 final；否则逐个执行工具。
7. 每个 tool result 即时 append，然后进入下一 step。

默认最多 50 step。达到上限会返回可继续的用户提示并保持 transcript 闭合，不把 Gateway 进程视为失败。

## Tool 数据流

`ToolExposureState` 在 turn 内持续存在。direct 工具最初可见；deferred 工具通过 `tool_search` 暴露；读取允许的 `SKILL.md` 会激活 owner-gated tools。新 exposure 从下一 provider step 使用。

Tool execute context 包含 handle、session、route、turn 和 exposure state。工具可以返回 model-visible content、artifact files 与受控 session state patch。Runtime 先写 state patch/发送 artifact，再把 tool result 放入 canonical history；错误转换成 `is_error` result，不让模型看见未闭合 tool use。

## 持久化

- SQLite 保存 session、response route、pending event、turn/tool/skill usage 和 Dashboard 查询数据。
- `session_transcripts/*.jsonl` 只追加 message、turn metadata 与最小 `context_patch`。
- `sessions.json` 保存平台 source 到 session id 的稳定 binding。
- replay cache 使用文件 size/mtime 签名，并在进程内 append 后直接更新。
- 已处理 base64 image 在持久化边界替换为占位，不长期保存二进制正文。

## Cancel 与失败

RunHandle 的 signal 同时中断 provider、summary、MCP 和 process。取消发生在多个 tool use 中间时，剩余调用写 cancelled stub。Provider retryable failure 在 step 内重试；context overflow 走一次强制 compaction；结构性错误或重复 overflow 终止 turn。

Runtime 返回 `completed|cancelled|error` outcome，Scheduler 释放 active slot。平台发送是独立 delivery 边界：发送失败不回滚已持久化 outcome，也不重放工具。

## 可观测性

turn_start/end、provider attempt、stream event、tool start/end、context checkpoint、usage 和 delivery failure 写入结构化日志或 trace。日志中的 token、authorization、cookie、base64、绝对敏感路径和 encrypted thinking data会被脱敏。

## 一次性业务命令边界

业务命令由 `python/lxeskill_cli/lxeskill/catalog.json` 注册，模型通过 native `exec` 启动独立的 `lxeskill ...` 进程。Gateway policy 决定允许的 skill types；`AgentRuntimeHost` 据此构造可见 skill scope，并由 Runtime exec adapter 注入 `LXESKILL_SKILL_SCOPE`。CLI 负责最终授权与 dispatch；Runtime process manager 负责 timeout、最大输出、abort 和 Windows 进程树终止。常驻 Bun 进程不加载 Python 业务 module。
