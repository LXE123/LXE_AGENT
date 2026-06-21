# Runtime Context 文档

状态：Current

## 目的

这个目录解释当前 runtime 如何保存、组装、发送和控制上下文。读者如果在排查历史消息为什么这样落盘、system prompt 和 messages 如何进入 LLM、tool schema 为什么这样传给 provider，或上下文为什么被裁剪压缩，应该先从这里建立地图。

## 设计理念

Context management 被拆成几层共同语言：state 和 canonical message 负责保存历史，context assembly 负责把一次 turn 组装成请求，tool schema 负责工具定义的内部格式和 provider 适配，pruning/compaction 负责预算控制。这样存储格式、prompt 组装、工具协议和上下文压缩不会在同一篇文档里互相覆盖。

## 链路位置

这一组文档位于 `SessionScheduler -> TurnHandler -> AgentLoop -> LLM provider` 链路中的 `AgentLoop` 内部。Gateway 把 `AgentJob` 送进 turn handler 后，context management 决定本轮 LLM 看到哪些历史、当前输入、system prompt 和 tools；LLM/tool step 结束后，它又决定哪些消息写回长期 history。

本目录是当前 runtime 上下文体系的专题入口。它只维护当前代码事实，不保留旧草稿或设计史。

事实来源：

- [shared/agent_state.py](../../../../shared/agent_state.py)
- [agent_runtime/context_pipeline.py](../../../../agent_runtime/context_pipeline.py)
- [agent_runtime/tool_schema_adapter.py](../../../../agent_runtime/tool_schema_adapter.py)
- [agent_runtime/llm_adapter.py](../../../../agent_runtime/llm_adapter.py)
- [shared/db/sqlite/session_messages.py](../../../../shared/db/sqlite/session_messages.py)

## 阅读顺序

1. [Canonical Message 与 Context State](canonical_message.md)：当前 `state_data` shape、message roles、content blocks、JSONL storage 和 provider message adaptation。
2. [Context Assembly](context_assembly.md)：每个 turn 如何组装 system prompt、messages 和 tool schemas。
3. [Tool Schema](../tools/tool_schema.md)：内部 canonical `ToolSchema`、registry 输出和 Anthropic schema adaptation。
4. [上下文裁剪与压缩实现细节](context_pruning_compaction.md)：历史图片裁剪、tool result prune、compaction、history limit 和 overflow recovery。
