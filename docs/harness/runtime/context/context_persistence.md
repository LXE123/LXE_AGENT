# Context Persistence

状态：Current

## 目的

这篇文档解释一次 turn 中产生的 canonical messages 如何进入长期事实日志，以及模型下一次请求看到的 `state_data.context.messages` 如何从事实日志派生出来。读者如果想理解 transcript、model-visible context、checkpoint、replacement、JSONL 和 SQLite 的边界，应该读这一篇。

## 设计理念

当前上下文持久化分成两层：

- **Transcript**：append-only 事件日志，是用户可见历史和恢复审计的事实源。
- **Model-visible context**：从 transcript replay 得到的模型工作视图，可以被 compaction、repair、history limit 或 reset 替换。

压缩和裁剪不再重写唯一历史。它们只追加一个带 `replacement_history` 的 replacement kind 事件，声明“从这里开始，模型视图替换为这份 `replacement_history`”。用户视图仍可看到原始 message 事件和一条压缩/重置标记。

## 存储形态

SQLite `agent_sessions` row 保存 session metadata、metrics、model、title 和 `message_count`。长文本历史保存在 JSONL：

```text
session_transcripts/<session_id>.jsonl
```

旧的 `session_messages/<session_id>.jsonl` 保留为 legacy migration 来源。老 session 第一次加载且没有 transcript 时，会把旧 messages 写成 `kind="legacy_import"` 的 replacement seed；旧文件不会被删除。

## Transcript 事件

事件基础形态：

```json
{"ts": 1780000000.0, "kind": "message"}
```

当前事件类型：

- `message`：一条 canonical message。写入前会剥离 inline image base64，只保留 media type 和占位文本；新 tool result 仍先经过 step 级 10k token 裁剪。
- `compaction`：summary compaction，额外带 `summary_text`、`compacted_count`、`trigger`。
- `repair`：provider request 前 sanitizer 修复闭合性后的模型视图。
- `history_limit`：turn 后 history limit 收缩后的模型视图。
- `context_reset` / `memory_clear`：模型视图清空，但 transcript 事件保留。
- `legacy_import`：旧 `session_messages` 导入种子。

除 `message` 外，上述事件都是模型视图替换节点，包含 `replacement_history` 和 `reason`；事件里也保留同名 `replacement_kind` 字段，方便兼容和查询。读取路径仍兼容早期开发期写出的 `kind="replacement"` 包装事件。

## Replay 规则

`load_agent_session()` 加载 session 时会 replay transcript：

1. 从头读取事件。
2. 遇到 `compaction`、`repair`、`history_limit`、`context_reset`、`memory_clear`、`legacy_import` 时，把当前 model-visible messages 替换为该事件的 `replacement_history`。
3. 遇到后续 `message` 时，继续 append 到 model-visible messages。
4. 最终结果放入 `state_data.context.messages`。

因此 `state_data.context.messages` 是模型工作视图，不是完整 transcript。

## Checkpoint 写入

`AgentLoop` turn 内产生完整 canonical message 后立即 checkpoint：

- user message
- assistant tool_call
- tool_result
- final assistant reply
- LLM error reply
- max-step terminal reply

这些 checkpoint 追加 transcript `message` 事件。流式 delta 不作为 message 事件写入。

当 runtime 改写 model-visible context 时，checkpoint 追加对应 kind 的 replacement 事件：

- pre-call repair
- pre-call / overflow / post-turn compaction
- post-turn history limit
- post-turn repair
- reset / memory clear

## Turn 末边界

turn 末 `_persist_and_deliver()` 仍保存 metrics、title、model 等 session metadata，但不再把 `state_data.context.messages` 作为完整快照重写进 message JSONL。model-visible context 的变化必须通过 transcript replacement kind 事件持久化。

这样做的结果是：

- 用户视图可以展示完整 transcript message 事件和压缩标记行。
- 模型视图可以通过 replacement kind replay 恢复到压缩后的工作集。
- 崩溃恢复时，如果 assistant tool_call 已写但 tool_result 未写，provider request 前 sanitizer 仍会补 synthetic tool result stub，保持闭合。
