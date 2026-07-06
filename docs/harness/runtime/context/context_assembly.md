# Context Assembly

状态：Current

## 目的

这篇文档解释一次 turn 进入 LLM 前，上下文是怎样从“历史 state + 当前输入 + 可用工具 + system prompt”组装成 provider 请求的。读者如果在排查模型为什么看到了某条历史、为什么某个 tool 可见、system prompt 每轮如何生成，应该读这一篇。

## 设计理念

Context assembly 的核心取舍是把请求拆成三个输入面：`system_prompt`、`messages` 和 `tool_schemas`。system prompt 每个 turn 重新构造，messages 由 canonical history 加当前 turn message 组成，完整 tool schema 走 provider tools 字段；这样 prompt 文本、对话历史和工具协议各自有清晰边界。

## 链路位置

这一层位于 `AgentLoop.run()` 开始阶段、真正进入 `_loop()` 调 LLM 之前。它读取 canonical messages，生成当前 user message 和 active tool schemas，完成 turn 前历史图片处理后，再把最终 messages、system prompt 和 tool schemas 交给 LLM streaming loop。

本文说明当前 `AgentLoop.run()` 如何把历史 state、当前输入、system prompt、messages 和 tool schemas 组装成一次 LLM 请求前的上下文。事实来源：

- [agent_runtime/loop.py](../../../../agent_runtime/loop.py)
- [agent_runtime/context_pipeline.py](../../../../agent_runtime/context_pipeline.py)
- [agent_runtime/tool_registry.py](../../../../agent_runtime/tool_registry.py)

## Turn 前组装顺序

一次普通 turn 进入 `_loop()` 前，顺序是：

1. `prune_processed_history_images()` 清理历史 messages 中已经处理过的图片。
2. `make_user_message()` 把当前用户输入或 inline content blocks 转成当前 turn 的 user message。
3. `_active_tool_names()` 从 tool registry 取本轮可见工具名。
4. `tool_registry.tool_schemas(tool_names)` 生成 canonical tool schemas。
5. `build_system_prompt()` 生成本轮 system prompt。
6. `build_llm_messages()` 合并历史 messages 和当前 turn message，生成进入 LLM loop 的 messages 和 context stats。

step 内 tool result 裁剪、compaction、history limit 的细节见 [context_pruning_compaction.md](context_pruning_compaction.md)。

## System Prompt 组成

`build_system_prompt()` 每个 turn 重新构造 system prompt。段落按"稳定前缀 + 易变后缀"排序，中间由 `SYSTEM_PROMPT_CACHE_BREAKPOINT`（定义在 `shared/llm/events.py`）分隔；transport 层会把 marker 之前的部分转成带 `cache_control: {"type": "ephemeral"}` 的 system block，使 provider prompt cache 不被每轮变化的后缀打断。

稳定前缀（打 cache 断点）：

| Section | 来源 | 说明 |
| --- | --- | --- |
| `## Soul` | `SOUL.md` | 文件存在时加入，只承载人格和语气，不含约束规则。 |
| `## Safety & Boundaries` | 硬编码 prompt | 全部安全与边界规则的唯一存放处：外部写操作确认门、隐私、消息平台规则、human oversight。 |
| `## Tool Call Style` | 硬编码 prompt | 工具调用叙述风格；各工具的具体使用规则以其自身 description 为准。 |
| `## Attachment Handling` | 硬编码 prompt | 非图片附件的处理方式。 |
| `## Skills (mandatory)` | 硬编码 prompt | 指导模型如何选择并读取 skill。 |

易变后缀（不缓存）：

| Section | 来源 | 说明 |
| --- | --- | --- |
| `<available_skills>` | 当前 bot skill policy 结果 | 每项包含 name、description、location。 |
| `## Runtime` | 当前 provider/model/OS/Python | 给模型运行环境事实。 |
| `## Workspace` | `Path.cwd()` | 告诉模型当前工作目录。 |
| `## Current Date & Time` | 本机当前时间（分钟精度） | 给模型当前日期时间和时区。 |

原 `## Tool Summaries` 段已移除：active tool schemas 完整走 provider tools 字段，system prompt 不再重复一份截断摘要；deferred MCP 工具的发现由 tool_search 工具自身的 description 承担。exec/process 的会话与轮询规则也已下沉到这两个工具的 description（`agent_runtime/tools/coding_tools.py`）。

`state_data` 当前传入 `build_system_prompt()`，但该函数现在没有读取其中的 context 内容。

## Messages 组成

`build_llm_messages()` 做两件事：

- 从 `state_data.context.messages` 读取历史 canonical messages。
- 追加当前 turn messages，并重新清洗成 canonical message 格式。

返回值是：

```python
tuple[list[dict[str, Any]], ContextBuildStats]
```

`ContextBuildStats` 当前包含：

- `estimated_tokens`：system prompt 和 messages 的估算 token 总量。
- `raw_turn_count`：按 message turn span 估算的 turn 数。
- `retained_turn_count`：当前与 `raw_turn_count` 相同。

token 估算使用 `estimate_tokens()`：普通字符串或 JSON 序列化内容按 UTF-8 bytes / 4 向上取整；canonical image block 不按 base64 长度估算，每张图固定按 1600 tokens 计入。

## Tool Schemas 在请求中的位置

tool schemas 不拼进 `messages`。运行时将上下文拆成三个输入面：

```text
system_prompt: string
messages: canonical messages
tool_schemas: canonical tool schemas
```

完整参数 schema 通过 provider adapter 作为请求顶层工具定义传给模型；system prompt 不包含工具摘要。

真正发 provider request 前，`_prepare_provider_messages()` 会用 `request_context_token_estimate()` 估算完整请求预算：

```text
system_prompt + messages + tool_schemas
```

如果这个完整预算超过 context window 的 90%，会先触发 `maybe_compact_history(trigger="pre_call", extra_tokens=estimate_tokens(tool_schemas))`，再重新清理 provider-bound messages。

## `_loop()` 内部追加

进入 `_loop()` 后，当前 turn 新产生的 assistant message 和 tool result 会同时追加到：

- `current_turn_messages`：用于 turn 结束后持久化。
- `messages`：用于同一 turn 后续 step 继续发给 LLM。

这意味着同一个 turn 内的多步工具调用不需要重新读取持久化 history；它会在内存里的 `messages` 列表上持续追加，直到 turn 完成或失败。

## Turn 后持久化

turn 结束后，`AgentLoop.run()` 会把 `current_turn_messages` 追加进 `state_data.context.messages`，再执行 post-turn compaction 和 history limit。最终 `state_data_patch` 交给 `turn_handler` 写回 session storage，message history 会落到 JSONL session message 文件。

完整持久化边界和设计取舍见 [Context Persistence](context_persistence.md)。
