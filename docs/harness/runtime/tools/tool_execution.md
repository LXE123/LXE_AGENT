# Tool Execution

状态：Current

## 目的

这篇文档解释模型已经返回 tool call 之后，agent runtime 如何真正执行工具。读者如果在排查工具为什么没有执行、为什么显示 running/error、为什么 cancel 后还要补 tool result、为什么后台 `exec` 完成后会唤醒同一个 session，应该读这一篇。

## 设计理念

Tool execution 被拆成三层：`AgentLoop` 控制 step loop、取消和 canonical message history；`UnifiedToolRegistry` 负责从 tool name 找到 `ToolDefinition.handler`；具体 handler 负责自己的副作用和返回 `ToolResult`。这样模型协议、工具注册、工具副作用、stream 展示和历史写回不会混成一团。

## 链路位置

这一层位于 `AgentLoop._loop() -> UnifiedToolRegistry -> ToolExecutionContext -> ToolResult -> tool_result message`。它接在 [Tool Schema](tool_schema.md) 之后：schema 决定模型能调用什么，execution 决定模型已经调用后 runtime 如何处理结果。完整 turn 位置见 [Turn Execution](../turn_execution.md)。

本文事实来源：

- [agent_runtime/loop.py](../../../../agent_runtime/loop.py)
- [agent_runtime/tool_registry.py](../../../../agent_runtime/tool_registry.py)
- [agent_runtime/tool_executor.py](../../../../agent_runtime/tool_executor.py)
- [agent_runtime/types.py](../../../../agent_runtime/types.py)
- [agent_runtime/tool_display.py](../../../../agent_runtime/tool_display.py)
- [agent_runtime/tools/coding_tools.py](../../../../agent_runtime/tools/coding_tools.py)
- [agent_runtime/tools/process_sessions.py](../../../../agent_runtime/tools/process_sessions.py)
- [agent_runtime/final_answer_streamer.py](../../../../agent_runtime/final_answer_streamer.py)

## Lifecycle Map

```text
LLMResponse.tool_calls
  -> assistant tool_call message
  -> registry lookup
  -> tool start callbacks
  -> ToolDefinition.handler(**arguments)
  -> ToolResult or ToolExecutionError
  -> tool finish callbacks
  -> tool_result blocks
  -> next LLM step
```

Tool execution 不直接结束 turn。工具结果会先写回本轮 `current_turn_messages`，再作为下一次 LLM step 的上下文输入；只有后续 LLM 返回 text reply，turn 才会进入 final answer。

## Registry And Visibility

`AgentLoop` 初始化时调用：

```python
self.tool_registry = ensure_all_tools_registered(get_registry())
```

`ensure_all_tools_registered()` 当前注册三类工具：

- coding tools：`read`、`write`、`edit`、`ls`、`send_file`、`exec`、`process`。
- Feishu IM tools：群列表、消息读取、thread 消息读取、资源下载。
- browser tools：只有紫鸟 browser 配置可用时才注册 planner schemas。
- MCP tools：每个 turn 刷新 MCP runtime 后动态注册。模型看到的是 `mcp__...` 归一化工具名，handler 内部使用保存的 `server_name/raw_tool_name` 路由回 MCP session。

当前内置工具默认直接 active。MCP 工具按 `exposure` 决定直接暴露或 deferred；deferred 工具先留在本地 registry，模型通过 `tool_search` 搜索后，匹配工具才会进入下一步 provider tool schemas。完整参数 schema 如何发送给 provider 见 [Tool Schema](tool_schema.md)。

## ToolExecutionContext

`AgentLoop.run()` 在进入 `_loop()` 前创建 `ToolExecutionContext`：

- `session`
- `state_data`
- `on_progress`
- `cancellation_check`
- `turn_id`
- `response_route_id`
- `cancel_event`

它通过 `set_tool_context()` 写入 contextvar，工具 handler 可以用 `get_tool_context()` 读取当前 turn 上下文。`finally` 中会调用 `clear_tool_context()`，并把 `exec_ctx.state_data` 同步回 `AgentLoop.state_data`。

这层上下文的目的不是把所有工具变成有状态对象，而是给普通 async handler 一个统一入口：知道自己属于哪个 session、如何发 progress、如何感知取消、如何把 state patch 合并回 turn。

## Model Tool Call

当 `LLMResponse.is_tool_call` 为真时，`AgentLoop._loop()` 会：

1. 为每个 tool call 写 `StepLog(event="tool_call")`。
2. 把 assistant content 写成 canonical `tool_call` message。
3. 按返回顺序执行每个 tool call。

写入 history 的 assistant block 形态是：

```json
{
  "type": "tool_call",
  "id": "...",
  "name": "...",
  "arguments": {}
}
```

这一步必须先发生，因为后续 `tool_result` 需要用 `tool_call_id` 闭合这次调用。

## Handler Invocation

每个 tool call 执行前，runtime 会：

- 检查取消。
- 调用 `on_progress` 提醒当前正在执行工具。
- 调用 `_notify_tool_start()`，让 `FinalAnswerStreamer` 更新 tool running 状态。
- 通过 `tool_registry.get(tool_call.name)` 查找 `ToolDefinition`。
- 通过 `_register_tool_run()` 把 tool call 登记给 gateway `RunHandle` 提供的 callback。

如果 registry 找不到工具，会生成 error `tool_result`，不会调用 handler。

找到工具后执行：

```python
result: ToolResult = await tool_def.handler(**tool_call.arguments)
```

`ToolResult` 是 runtime 认可的唯一成功返回形态：

```python
ToolResult(
    content=[{"type": "text", "text": "..."}],
    details={},
)
```

`content` 可以包含 text block，也可以包含 image block。browser screenshot 类结果会在 executor 中转成 `image_content_block()`，普通文本结果通常用 `text_tool_result()`。

## Success And Failure

成功路径会生成 canonical `tool_result` block：

```json
{
  "type": "tool_result",
  "tool_name": "...",
  "tool_call_id": "...",
  "content": [],
  "is_error": false
}
```

同时会写 `StepLog(event="tool_result")`，记录 `tool_result_preview`、`success=True` 和 `duration_ms`。

失败路径包括两类：

- `ToolExecutionError`：工具明确抛出的、可以给模型看的失败。
- 其它 exception：runtime 会截取 traceback，包装成工具失败 observation。

失败时写入 `is_error: true` 的 `tool_result`，并写 `StepLog(event="tool_error")`。无论成功还是失败，`finally` 都会调用 tool run finisher，让 `RunHandle` 清掉 active tool run。

## FinalAnswerStreamer

`FinalAnswerStreamer` 负责把 tool 状态显示给平台侧 streaming UI。tool execution 期间，`AgentLoop` 通过 callbacks 通知它：

- `start_tool_pending()`：LLM 正在形成 tool call 或即将执行工具时可显示 pending。
- `push_tool_start()`：工具进入 running。
- `push_tool_finish()`：工具完成，状态为 `success` 或 `error`。

展示内容由 `tool_display.py` 的 `build_tool_display_step()` 和 `sanitize_tool_steps()` 统一清洗。它会尽量把 tool name、参数摘要、状态和耗时变成适合 UI 展示的结构，同时隐藏明显敏感的 URL token、绝对路径和命令细节。

## Cancellation And Synthetic Cancel

Runtime 取消信号来自 gateway `RunHandle`，但 `AgentLoop` 只接收 callback：

- `provider_cancel_registrar`
- `tool_run_registrar`
- `tool_run_finisher`
- `cancellation_check`
- `cancel_event`

tool execution 前、中、后都会检查取消。如果取消发生时某些 tool call 已经写入 assistant message，但还没有对应 tool result，runtime 会补 synthetic cancel tool result：

```text
[The conversation was interrupted before this tool could finish.]
```

这个 synthetic cancel result 的目的，是保持 canonical message history 闭合。否则下一次把历史发给 provider 时，会出现 assistant `tool_call` 没有对应 `tool_result` 的不完整对话。

## Exec And Process Sessions

`exec` 和 `process` 是 coding tools 的特殊组合：

- `exec` 启动 shell command。
- 如果命令在 `yield_ms` 内完成，直接返回 completed payload。
- 如果命令仍在运行，返回 background session id。
- `process` 用于 poll、log、write、kill、remove 这些 exec session 操作。

后台 exec session 完成时，`process_sessions.py` 会生成 pending event，并调用 `request_heartbeat_wake()`。这个事件之后会通过 gateway heartbeat 回到同一个 scheduler，再进入普通 runtime loop。gateway 侧唤醒去重和调度见 [Emitter and heartbeat wake](../../gateway/emitter_heartbeat_wake.md)。

Tool execution 文档只说明这个边界：后台任务不会直接绕过 agent loop 发最终回复，而是以 pending event 形式回到主链路。

## Browser Handler Family

browser tools 不是普通 Python handler 直接完成所有工作。`register_browser_tools()` 从 browser planner schemas 注册 `ToolDefinition`，handler 来自 `make_browser_tool_handler()`。

执行时：

1. `make_browser_tool_handler()` 读取当前 `ToolExecutionContext`。
2. `build_browser_tool_call()` 校验并归一化参数。
3. `_execute_browser_tool()` 调用 `invoke_browser_tool_fact()`。
4. browser pack 返回 `ToolExecutionFact`。
5. `_tool_result_from_fact()` 把 fact 转成 `ToolResult`。

`ToolExecutionFact` 可以携带 state patch、snapshot、verification、clicked element、control 信息和 screenshot。本文只描述 browser tools 如何接入 runtime tool execution；browser pack 内部后续可单独成文。

## History Writeback

每个 LLM step 的所有 tool calls 执行完后，`AgentLoop` 会把收集到的 tool result blocks 追加成一条 canonical tool message：

```json
{
  "role": "tool",
  "content": [
    {
      "type": "tool_result",
      "tool_call_id": "...",
      "content": "...",
      "is_error": false
    }
  ]
}
```

随后进入下一次 LLM step。turn 结束后，`current_turn_messages` 会随普通 turn history 一起追加到 `state_data.context.messages`，再经过 post-turn compaction 和 history limit。
