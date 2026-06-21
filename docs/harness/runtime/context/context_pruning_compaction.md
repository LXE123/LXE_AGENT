# 上下文裁剪与压缩实现细节

状态：Current

## 目的

这篇文档解释当前 runtime 如何控制上下文体积：哪些历史图片会被替换，哪些旧 tool result 会被裁剪，什么时候压缩历史，什么时候按 turn limit 截断。读者如果在排查模型上下文过大、历史突然变成 summary、tool result 内容被清空或 context overflow recovery，应该读这一篇。

## 设计理念

裁剪和压缩被独立出来，是因为它们改变的是“进入后续 LLM 请求的历史形态”，风险比普通 prompt 组装更高。当前实现优先保留最近 turn 的原文，把大体积图片和旧 tool result 当成预算压力来源处理，并在 post-turn 或 overflow 时用 summary 兜住更早的历史。

## 链路位置

这一层贯穿 `AgentLoop.run()` 的前后两端：turn 前先裁剪历史图片和旧 tool result，再进入 LLM loop；turn 后追加本轮 messages，再做 compaction 和 history limit；如果 LLM step 报 context overflow，则在 `_loop()` 内尝试压缩并重建 messages 后重试。

本文只维护当前 `AgentLoop` 对上下文的裁剪、压缩、history limit、历史图片裁剪和 context overflow recovery 实现。事实来源限定为：

- [agent_runtime/loop.py](../../../../agent_runtime/loop.py)
- [agent_runtime/context_pipeline.py](../../../../agent_runtime/context_pipeline.py)

本目录中其它文档只链接到这里，不重复维护这些实现细节。上下文基础格式见 [canonical_message.md](canonical_message.md)，turn 前组装链路见 [context_assembly.md](context_assembly.md)。

## 执行顺序

一次 `AgentLoop.run()` 中，上下文处理顺序是：

1. 历史图片裁剪：`prune_processed_history_images()` 先处理已持久化的历史消息。
2. 当前 user message：`make_user_message()` 根据当前输入文本或 inline content blocks 构造本轮 user message。
3. system prompt：`build_system_prompt()` 根据平台、工具 schema、visible skills 和当前 state 构造 system prompt。
4. turn 前 tool result prune：先用 `build_llm_messages()` 估算 prune 前 token，再调用 `prune_tool_results()` 修改历史 tool result，随后重新 build messages。
5. agent loop：`_loop()` 用当前 messages、system prompt 和 tool schemas 逐 step 调 LLM / 执行工具。
6. append messages：turn 结束后将本轮需要持久化的 messages 追加到 state。
7. post-turn compaction：`maybe_compact_history(trigger="post_turn")` 在追加后检查是否需要压缩旧消息。
8. history limit：`apply_message_history_limit()` 在 compaction 后按平台和群聊/私聊配置截断旧 turn。
9. final stats：最后再次 `build_llm_messages()` 生成 turn 结束后的 context stats，写入 `TurnLog`。

context overflow recovery 是 `_loop()` 里的异常恢复分支，不在上述正常 post-turn 顺序里。

## 历史图片裁剪

`prune_processed_history_images()` 只处理已经在 `state_data` 里的历史消息，不处理当前 turn 新进入的图片。

- 历史 `user` message 里的 inline `image` block 会被替换为 text block。
- 历史 `tool` message 的 `tool_result.content` 如果是 inline blocks，其中的 `image` block 也会被替换为 text block。
- 替换文本是 `[image data removed - already processed by model]`。

这样做的效果是：图片在被模型看过之后，不再长期以 base64 形式留在后续上下文里。

## Tool Result Prune

`prune_tool_results()` 在每个 turn 进入 LLM loop 前执行。它只修改历史 messages 中 role 为 `tool`、block type 为 `tool_result` 的内容。

当前阈值：

| 常量 | 当前值 | 含义 |
| --- | ---: | --- |
| `TOOL_RESULT_SOFT_SHARE` | `0.30` | tool result token 占总上下文 token 超过 30% 后进入 soft trim |
| `TOOL_RESULT_HARD_SHARE` | `0.50` | tool result token 占总上下文 token 超过 50% 后尝试 hard clear |
| `TOOL_RESULT_TRIM_THRESHOLD_CHARS` | `4000` | 单个 tool result 内容小于 4000 字符时不做 head/tail trim |
| `TOOL_RESULT_TRIM_HEAD_CHARS` | `1500` | soft trim 保留头部字符数 |
| `TOOL_RESULT_TRIM_TAIL_CHARS` | `1500` | soft trim 保留尾部字符数 |
| `MIN_PRUNABLE_TOOL_CHARS` | `50000` | hard clear 前要求所有可修剪 tool result 总字符数至少达到 50000 |

执行逻辑：

1. 先计算当前上下文总 token 和所有 tool result token。
2. 如果 tool result share 大于 `0.50`，且可修剪 tool result 总字符数至少 `50000`，从旧到新把 tool result content 替换为 `[Old tool result content cleared]`，直到 share 回到 `0.50` 以下或没有可清理项。
3. 如果当前 share 仍大于 `0.30`，从旧到新对长度不小于 `4000` 的 tool result 做 head/tail trim，保留头部 `1500` 字符和尾部 `1500` 字符，中间插入 `...[trimmed]...`。
4. 每清理一项都会用估算 token 做减法更新当前 share，达到目标阈值后停止。

当前是无 TTL 修剪机制。`prune_tool_results()` 保留了 `now_ts` 参数，但函数体内直接忽略该参数；是否修剪只由当前上下文占比、字符数和阈值决定。

## Compaction

`maybe_compact_history()` 会在两种场景被调用：

- turn 正常结束后：`trigger="post_turn"`。
- LLM step 抛出 context overflow 类错误后：`trigger="overflow"`。

触发条件是：

```text
estimated_tokens > model_context_window_tokens - DEFAULT_RESERVE_TOKENS
```

当前默认值：

- `DEFAULT_CONTEXT_WINDOW_TOKENS = 256000`
- `DEFAULT_RESERVE_TOKENS = 20000`
- `RECENT_RAW_TURN_TOKEN_LIMIT = 20000`

`model_context_window_tokens` 优先来自 `active_agent_planner_capabilities().context_window_tokens`，读取失败时回退到 `256000`。

压缩时，`_select_recent_message_turns()` 从最新 turn 往前累计估算 token，直到达到 `20000` 左右，将这些较新的 turn 保留为原文。更旧的 messages 会被 `_summarize_history()` 渲染成 transcript 后交给 LLM 总结。

压缩成功后，持久化 messages 会变成：

```json
[
  {
    "role": "user",
    "content": "The conversation history before this point was compacted into the following summary: ..."
  },
  "... retained recent messages ..."
]
```

summary message 由 `make_compaction_summary_message()` 生成。当前 summary 是作为一条 `user` message 写回 context，不是单独的 side table 或独立 compaction record。

## History Limit

`apply_message_history_limit()` 在 post-turn compaction 之后运行。它按 message turn span 截断旧 turn，而不是按单条 message 截断。

当前默认平台配置只有：

```python
DEFAULT_CHANNEL_HISTORY_LIMITS = {
    "feishu": {"dmHistoryLimit": 20},
}
```

含义：

- 飞书私聊默认保留最近 20 个 turn。
- 飞书群聊当前没有默认 `groupHistoryLimit`，limit 解析为 `0`，因此默认不截断。
- 其它平台没有默认配置时也不截断。

## Context Overflow Recovery

在 `_loop()` 中，如果一次 LLM step 抛出的异常被 `is_context_overflow_error()` 判断为上下文溢出，并且本 step 还没有做过 overflow recovery，会执行：

1. `maybe_compact_history(trigger="overflow")` 尝试压缩当前 `exec_ctx.state_data`。
2. 如果压缩成功，用新的 state 和当前 turn messages 重新 `build_llm_messages()`。
3. 清掉上一段 stream summary。
4. 设置 `overflow_recovered = True`，继续当前 step 的下一次循环尝试。

同一轮 `_loop()` 里，成功收到一次 LLM response 后会把 `overflow_recovered` 重置为 `False`。如果 context overflow 后没有成功压缩，或已经恢复过但再次失败，则走普通 LLM error 分支，写入 error step 并返回错误回复。

## 日志观测

当前 `TurnLog` 会记录：

- prune 是否发生：`prune_performed`
- prune 估算回收 token：`prune_recovered_tokens`
- compaction 是否发生：`compaction_performed`
- turn 前后 context stats：`context_stats_before` / `context_stats_after`

`_log_context_warnings()` 当前只按上下文使用率发 `[Turn:CONTEXT]` warning：当 `estimated_tokens / context_window > 0.8` 时提示接近 compaction threshold。tool result share warning 在当前代码里没有对应分支。
