# Turn Execution

状态：Current

## 目的

这篇文档解释一个已经通过 gateway 路由和调度的 `AgentJob`，在 runtime 内部如何被执行完。读者如果在排查一次回复为什么没有发送、pending event 为什么进入了本轮、heartbeat job 为什么触发、state patch 为什么写回，应该读这一篇。

## 设计理念

Turn execution 被拆成三层：`handle_unified_turn_job()` 处理 job 级别的输入输出和平台反馈，`run_turn()` 准备 runtime 依赖和可见 skills，`AgentLoop.run()` 执行真正的 LLM/tool step loop。这样 job 生命周期、skill/tool 可见性、LLM 循环和持久化不会挤在一个函数里。

## 链路位置

这一层位于 `SessionScheduler` 之后、context/tools/LLM integration 之前。它从 gateway 收到 `AgentJob` 和 `RunHandle`，进入 `AgentLoop` 后调用 [Runtime Context](context/README.md)、[Runtime Tools](tools/README.md) 和 [LLM Integration](../llm/README.md)，最后产出 `TurnOutcome` 并交回 turn handler 持久化和发送。

本文事实来源：

- [agent_runtime/turn_handler.py](../../../agent_runtime/turn_handler.py)
- [agent_runtime/runtime.py](../../../agent_runtime/runtime.py)
- [agent_runtime/loop.py](../../../agent_runtime/loop.py)
- [agent_runtime/final_answer_streamer.py](../../../agent_runtime/final_answer_streamer.py)
- [agent_runtime/types.py](../../../agent_runtime/types.py)

## 输入：AgentJob

Gateway scheduler 调用 `GatewayApp._execute_agent_job()`，再进入 `handle_unified_turn_job()`。runtime 不直接读取平台 adapter，它只消费已经由 gateway 归一化过的 job payload。

当前 payload 主要包含：

- `session_id`
- `response_route_id`
- `session_key`
- `source`
- `user_text`
- `job_id`
- `job_kind`
- `raw_data`
- `user_content_blocks`

`job_kind` 当前主要有两类：普通用户 turn 使用 `turn`，后台唤醒使用 `job_kind="heartbeat"`。

## TurnHandler

`handle_unified_turn_job()` 是 runtime 的 job 入口。它负责：

- 从 job 中取出 session、route、输入文本、source 和 raw data。
- 加载当前 session；session 不存在时直接结束 job。
- 为 Feishu 普通 turn best-effort 发送 typing indicator。
- 当 session 支持流式 final answer 时创建 `FinalAnswerStreamer`。
- 构造 tool start / finish 回调，把工具状态推给 final answer stream。
- 构造 cancellation check，把 `RunHandle.cancelled` 传给 agent loop。

这一层不直接执行 LLM step，也不直接运行工具。

## 普通 Turn

普通 `turn` 会先处理 pending system events：

1. 从 `raw_data.system_events` 读取 gateway 在路由阶段弹出的事件。
2. 把每条事件格式化成 `System: [time] ...` 文本。
3. 如果本轮有 inline content blocks，把 system events 插到 blocks 前面。
4. 如果本轮只有文本，把 system events 拼到用户文本前面。
5. 用户原文中伪造的 `System:` 前缀会被改写成 `System (untrusted):`。

这样后台事件可以搭本轮用户消息进入 agent loop，但不会被误认为真正的系统 prompt。

## Heartbeat Job

`job_kind="heartbeat"` 用于后台 pending event 主动唤醒。它和普通 turn 走同一个 runtime loop，但输入构造不同：

1. 从 session pending events 中 `pop_agent_session_pending_events(session_id)`。
2. 如果没有 pending events，只 touch session 并结束。
3. 把 pending events 格式化成 system event 文本。
4. 构造 heartbeat prompt，要求 agent 只处理这些后台完成事件。
5. 清空 `user_content_blocks`，再调用 `run_turn()`。

Heartbeat job 的价值是复用同一套 `AgentLoop`、context、tool 和 final emit 机制，而不是绕过 session 串行规则单独发消息。

## run_turn()

`run_turn()` 是 runtime 的轻量入口。它负责：

- 确保所有 runtime tools 注册到 registry。
- 从 session 读取 `state_data`。
- 根据当前 session 的 bot id 和 permission policy 加载 visible skills。
- 把输入、callbacks、cancel handles 和 visible skills 传给 `run_agent_turn()`。

Skill 的完整 catalog 见 [Skill docs](../skill/README.md)。这里不复制 skill prompt，只说明本轮 runtime 如何拿到可见 skill 队列。

## AgentLoop.run()

`AgentLoop.run()` 是一次 turn 的核心执行体：

1. 创建 `TurnLog` 和 trace writer。
2. 裁剪已处理历史图片。
3. 构造当前 user message。
4. 读取 active tool names 和 tool schemas。
5. 构造 system prompt 和 LLM messages。
6. 做 turn 前 tool result prune。
7. 建立 `ToolExecutionContext`。
8. 进入 `_loop()` 执行 LLM/tool step。
9. turn 结束后追加本轮 messages。
10. 执行 post-turn compaction 和 history limit。
11. 生成最终 context stats 和 `TurnOutcome`。

Context 细节见 [Runtime Context](context/README.md)，tool schema 和 tool execution 细节见 [Runtime Tools](tools/README.md)。

## Step Loop

`AgentLoop._loop()` 每个 step 会：

- 检查是否取消。
- 调用 LLM streaming 接口。
- 如果返回 text reply，生成最终 assistant message 并结束。
- 如果返回 tool calls，先记录 assistant tool call message。
- 按顺序执行每个 tool call，并收集 tool result blocks；完整生命周期见 [Tool Execution](tools/tool_execution.md)。
- 将 tool result message 追加回当前 turn messages。
- 继续下一 step，直到文本回复、错误、取消或达到最大步数。

LLM streaming 每个 step 最多尝试 3 次。context overflow 不走普通重试，而是触发 compaction recovery 并重建 messages 后继续。

## TurnOutcome

`TurnOutcome` 是 agent loop 返回给 turn handler 的统一结果：

- `status`：`done`、`waiting`、`cancelled` 或 `error`。
- `reply`：最终要展示给用户的文本。
- `state_data_patch`：本轮更新后的 state。
- `messages_to_persist`：取消场景下需要保留的已完成消息。
- `turn_log`：本轮结构化执行日志和 metrics。

`AgentLoop.run()` 返回后，`handle_unified_turn_job()` 继续负责持久化和发送。

## 持久化与 Final Emit

turn handler 会重新加载最新 session，然后调用 `_persist_and_deliver()`：

- 用 `state_data_patch` 更新 session state。
- 从 `TurnLog` 计算 `api_call_count`、`tool_call_count`、`input_tokens` 和 `output_tokens` 的 metrics delta。
- 普通 turn 使用原始 user text 作为 title candidate。
- 如果 final answer stream 已经发送过最终内容，则跳过重复 final。
- 如果 outcome 是 `cancelled`，也跳过 final emit。
- 否则通过 `emit_final_fn()` 发送最终回复。

typing indicator 如果已启动，会在 `finally` 中 best-effort 停止。

## 取消边界

Runtime 取消信号来自 gateway 的 `RunHandle`。turn handler 把 `cancel_event`、`thread_cancel_event`、provider cancel registrar 和 tool run registrar 传入 `run_turn()`，再传给 `AgentLoop`。

如果取消发生在 tool call 已经写入但 tool result 尚未完成的阶段，agent loop 会补 synthetic error tool result，保持 canonical message history 闭合。
