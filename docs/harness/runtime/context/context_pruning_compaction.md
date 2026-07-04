# 上下文裁剪与压缩实现细节

状态：Current

## 目的

这篇文档解释当前 `AgentLoop` 如何在 turn 前、turn 内、turn 后控制上下文体积。读者如果在排查历史图片为什么消失、某次 context overflow 后历史为什么变成 summary、为什么 turn 结束后只保留最近若干 turn，应该读这一篇。

## 设计理念

上下文裁剪和压缩不是普通 prompt 组装，它们会改变后续 LLM 能看到的历史形态。当前实现采用三段式防线：turn 前移除已经处理过的历史图片，turn 内在 tool result append 前做单结果裁剪、在 provider request 前做预算检查和压缩/老化，provider 报 context overflow 时再做恢复性压缩，turn 后做长期历史治理。

## 链路位置

这一层贯穿 `AgentLoop.run()`：turn 前处理 `state_data.context.messages` 并构造本轮 messages；turn 内在 `_loop()` 中处理新 tool result、pre-call 预算管理和 LLM step overflow；turn 后追加本轮 messages，再做 compaction、history limit 和 final context stats。上下文基础格式见 [canonical_message.md](canonical_message.md)，turn 前组装链路见 [context_assembly.md](context_assembly.md)。

本文只维护当前 `AgentLoop` 对上下文裁剪、压缩、history limit、历史图片裁剪和 context overflow recovery 的实现。事实来源限定为：

- [agent_runtime/loop.py](../../../../agent_runtime/loop.py)
- [agent_runtime/context_pipeline.py](../../../../agent_runtime/context_pipeline.py)

## 总览

```text
turn 前:
  state_data
  -> prune_processed_history_images()
  -> make_user_message()
  -> build_system_prompt()
  -> build_llm_messages()

turn 内:
  AgentLoop._loop()
  -> tool result append 前 trim_step_tool_result_blocks()
  -> provider request 前 sanitize + request budget estimate
  -> maybe_compact_history(trigger="pre_call")
  -> LLM step
  -> context overflow?
  -> maybe_compact_history(trigger="overflow")
  -> rebuild messages and retry

turn 后:
  append current_turn_messages
  -> maybe_compact_history(trigger="post_turn")
  -> apply_message_history_limit()
  -> final build_llm_messages() stats
```

当前没有 TTL 修剪机制。turn 前不再按时间、占比或字符数裁剪历史 tool result；如果历史 tool result 让请求预算过高，后续会由 pre-call compaction 或 context overflow recovery 处理。

## Turn 前

Turn 前阶段发生在本轮第一次 LLM request 之前。它只处理已经持久化在 `state_data` 里的历史内容；当前用户输入和本轮即将产生的 tool result 不在这个阶段被裁剪。

### 历史图片裁剪

#### 目的

历史图片裁剪的目的是移除已经被模型处理过的 base64 图片，避免图片在后续每个 turn 中重复占用大量上下文预算。图片第一次进入模型时仍可见；进入历史后，后续 turn 只需要知道“这里曾经有一张图片”。

#### 设计理念

当前实现把历史图片视为高成本、低复用的上下文内容。它不删除整条 message，也不删除文本说明，只把历史 `image` block 替换成固定文本占位符，让对话结构仍然闭合，同时避免长期携带二进制内容。

#### 细节

`AgentLoop.run()` 最开始调用：

```python
self.state_data, _ = prune_processed_history_images(self.state_data)
```

`prune_processed_history_images()` 只处理 `state_data.context.messages` 中已经存在的历史消息：

- 历史 `user` message 里的 inline `image` block 会被替换为 text block。
- 历史 `tool` message 的 `tool_result.content` 如果是 inline blocks，其中的 `image` block 也会被替换为 text block。
- 替换文本是 `[image data removed - already processed by model]`。

它不处理本轮 `user_content_blocks` 里的新图片。本轮图片会先进入 `make_user_message()`，仍可被本轮 LLM 看见。

### 历史 Tool Result

#### 目的

历史 tool result 在 turn 前保持原样，避免 runtime 在没有 transcript/model-visible context 分层时继续改写已持久化的工具结果内容。

#### 设计理念

当前实现不再对历史 tool result 做整段清空或 head/tail trim。上下文预算控制交给三个更明确的入口：新 tool result append 前的 step 级裁剪、provider request 前的预算检查和 compaction/aging、provider 报 context overflow 后的恢复性 compaction/aging。

#### 细节

`AgentLoop.run()` 不再调用历史 tool result prune。`build_llm_messages()` 会按 `state_data.context.messages` 中的内容直接组装历史 tool result。

这不影响本轮新产生的 tool result：它们仍会在 append 前通过 `trim_step_tool_result_blocks()` 执行单个结果的 token 预算裁剪。裁剪是 block-aware 的：字符串 content 维持原有文本裁剪；list content 中的 image block 原样保留、不参与文本预算；多个 text block 会共享一个总文本预算，超限时合并成一个裁剪后的 text block。

## Turn 内

Turn 内阶段发生在 `AgentLoop._loop()` 每个 LLM/tool step 之间。它现在有两个主动入口：tool result 返回后、append 前执行单结果裁剪；每次发 provider request 前执行 sanitizer、预算估算和必要的压缩/老化。provider 明确报 context overflow 时仍有一次恢复性重试。

### Step Tool Result 裁剪

#### 目的

Step 级 tool result 裁剪的目的是在新工具结果进入本轮 messages 之前限制单个结果的体积，避免一个工具调用直接把下一次模型请求撑爆。

#### 细节

`trim_step_tool_result_blocks()` 对每个新 `tool_result` block 单独处理，默认上限是 `STEP_TOOL_RESULT_MAX_TOKENS = 10000`：

- 字符串 content 使用 UTF-8 byte 头尾保留裁剪，token 估算为 `ceil(bytes / 4)`。
- list content 不再 `json.dumps()` 降级成字符串。
- list content 的 image block 原样保留，不参与文本预算；历史阶段会由 `prune_processed_history_images()` 替换成占位符。
- list content 的多个 text block 共享一个总文本预算，超限时合并为一个裁剪后的 text block。

### Pre-Call Budget Guard

#### 目的

Pre-call budget guard 的目的是在真正请求供应商前检查完整请求体积，提前处理 `system_prompt + messages + tool_schemas`，而不是等 provider 报错。

#### 细节

`_prepare_provider_messages()` 每次请求前会先运行 `sanitize_messages_for_provider()`，再调用 `request_context_token_estimate()` 估算：

```text
estimate_tokens(system_prompt) + estimate_tokens(messages) + estimate_tokens(tool_schemas)
```

当估算值超过 `context_window * PRECALL_COMPACTION_USAGE_THRESHOLD`，当前默认是 90%，会调用：

```python
maybe_compact_history(trigger="pre_call", extra_tokens=estimate_tokens(tool_schemas))
```

`extra_tokens` 让 `maybe_compact_history()` 在内部继续按完整请求预算判断，而不是只看 system 和 messages。

### Context Overflow Recovery

#### 目的

Context overflow recovery 的目的是在 provider 拒绝当前请求时，给本轮一次恢复机会。它尝试压缩旧历史，重建 messages，然后继续当前 step，而不是立刻把 overflow 暴露给用户。

#### 设计理念

当前实现把 overflow recovery 设计成“异常恢复”。它复用 `maybe_compact_history()`，先尝试摘要旧历史；如果没有可摘要的旧前缀，或者摘要后仍超预算，会对当前 turn 中预算外的旧 tool result 和旧 assistant thinking 做 deterministic aging。

#### 细节

在 `_loop()` 中，如果一次 LLM step 抛出的异常被 `is_context_overflow_error()` 判断为上下文溢出，并且本 step 尚未做过 overflow recovery，会执行：

1. `maybe_compact_history(trigger="overflow", extra_tokens=estimate_tokens(request_tool_schemas))` 尝试压缩或老化当前 `exec_ctx.state_data`。
2. 如果压缩成功，用新的 state 和当前 `current_turn_messages` 重新 `build_llm_messages()`。
3. 清掉上一段 stream summary。
4. 设置 `overflow_recovered = True`，继续当前 step 的下一次循环尝试。

同一轮 `_loop()` 中，成功收到一次 LLM response 后会把 `overflow_recovered` 重置为 `False`。如果 context overflow 后没有成功压缩，或已经恢复过但再次失败，则走普通 LLM error 分支，写入 error step，并返回错误回复。

`is_context_overflow_error()` 当前会识别：

- error 对象上的 `context_overflow=True`
- 文本中包含 `context overflow`、`context window`、`maximum context`、`too many tokens`、`prompt is too long`、`model token limit` 等提示

### Compaction 与 Turn 内 Aging

#### 目的

Compaction 的目的是把旧历史压成一条 summary message，让当前 turn 能继续发送给 provider。Turn 内 aging 是 compaction 无法释放足够空间时的确定性兜底，专门处理当前 turn 内较旧的 tool result 和 assistant thinking。

#### 设计理念

`maybe_compact_history()` 仍然优先走原有摘要压缩：保留最近约 `20000` estimated tokens 的 raw turn，把更旧 messages 总结成一条 summary message。只有当没有可摘要前缀，或摘要后仍超预算时，才进入 deterministic aging。

#### 细节

`maybe_compact_history()` 的 hard budget 是：

```text
estimated_tokens + extra_tokens > model_context_window_tokens - DEFAULT_RESERVE_TOKENS
```

`trigger="pre_call"` 时，pre-call 入口还会用 90% 窗口作为更早的触发线。

`trigger="overflow"` 表示 provider 或 adapter 已经明确报出 context overflow。这个入口不会因为本地粗略估算低于 hard budget 就直接 no-op，而是会强制尝试 summary compaction；如果没有可摘要前缀，或摘要后仍不足，再进入 deterministic aging。若最终没有任何可安全收缩内容，才会返回 `compacted=False`，由 LLM error 路径处理。

当前默认值：

- `DEFAULT_CONTEXT_WINDOW_TOKENS = 256000`
- `DEFAULT_RESERVE_TOKENS = 20000`
- `RECENT_RAW_TURN_TOKEN_LIMIT = 20000`
- `AGED_TOOL_RESULT_MAX_TOKENS = 1000`

`model_context_window_tokens` 优先来自 `active_agent_planner_capabilities().context_window_tokens`，读取失败时回退到 `256000`。

压缩时：

1. `_select_recent_message_turns()` 从最新 turn 往前累计估算 token。
2. 累计达到约 `20000` token 后，这部分较新的 turn 保留为原文。
3. 更旧的 messages 会被 `_summarize_history()` 渲染成 transcript 后交给 LLM 总结。
4. `make_compaction_summary_message()` 把 summary 写成一条 `user` message。

压缩后的 history 形态是：

```json
[
  {
    "role": "user",
    "content": "The conversation history before this point was compacted into the following summary: ..."
  },
  "... retained recent messages ..."
]
```

当前 summary 是内联写回 `state_data.context.messages`，不是 side table，也不是单独 compaction record。

Aging 时：

1. 找到最后一条 `user` message 到末尾的当前 turn span。
2. 从末尾往前累计 `estimate_tokens(message)`，最近约 `20000` estimated tokens 保持原样。
3. 超出近期预算的旧 `tool_result` 字符串 content 会裁剪到约 `1000` estimated tokens。
4. 超出近期预算的旧 `tool_result` list content 会把 text block 合并并共享约 `1000` estimated tokens，image block 替换成 `[image data removed - already processed by model]`。
5. 超出近期预算的旧 assistant message 保留 text/tool_call，删除 thinking/redacted_thinking；最后一条 assistant message 的 thinking/redacted_thinking 无条件保留。
6. 如果一级 aging 后仍超过 `context_window - DEFAULT_RESERVE_TOKENS`，预算外旧 `tool_result.content` 会进入第二档 stub：`[tool result elided to save context]`。

## Turn 后

Turn 后阶段发生在 `AgentLoop._loop()` 返回 `TurnOutcome` 之后。它会先把本轮需要持久化的 messages 追加到 state，然后再处理长期历史体积。

### Post-Turn Compaction

#### 目的

Post-turn compaction 的目的是在一次 turn 完整结束后，把过大的长期历史压缩成 summary，避免下一个 turn 一开始就背着过大的 context。

#### 设计理念

当前实现选择在 append messages 之后做 post-turn compaction。这样本轮用户输入、assistant tool call、tool result 和最终回复会先作为完整结构进入历史，再由 compaction 决定旧历史是否需要摘要。它优先保留最近约 `20000` token 的原文，把更早历史压成 summary。

#### 细节

Turn 结束后，`AgentLoop.run()` 会决定要追加哪些 messages：

- 普通完成或错误：追加 `current_turn_messages`。
- cancelled：追加 `outcome.messages_to_persist`，也就是取消前已经闭合、允许持久化的消息。

如果有 messages 被追加，就调用：

```python
maybe_compact_history(trigger="post_turn")
```

post-turn compaction 使用和 overflow/pre-call compaction 相同的摘要与 aging 机制：

- reserve tokens：`20000`
- recent raw turn token target：`20000`
- 默认 context window fallback：`256000`
- summary 写成一条 `user` message

压缩成功后，`turn_log.compaction_performed = True`。

### History Turn Limit

#### 目的

History turn limit 的目的是给特定平台设置硬性的历史轮数上限，避免即使没有触发 token compaction，长期会话也无限增长。

#### 设计理念

当前实现按 message turn span 截断，而不是按单条 message 截断。这样可以尽量避免留下半个 turn，比如只有 assistant tool call、没有对应 user 或 tool result 的碎片。

#### 细节

`apply_message_history_limit()` 在 post-turn compaction 之后运行。它按平台和会话类型读取配置：

```python
DEFAULT_CHANNEL_HISTORY_LIMITS = {
    "feishu": {"dmHistoryLimit": 20},
}
```

当前含义：

- 飞书私聊默认保留最近 20 个 turn。
- 飞书群聊当前没有默认 `groupHistoryLimit`，limit 解析为 `0`，因此默认不截断。
- 其它平台没有默认配置时也不截断。

如果 limit 生效，函数会计算 `_message_turn_spans()`，保留最近 limit 个 turn 的起始位置之后的 messages，再用 `update_context_state()` 写回 state。

### Final Context Stats

#### 目的

Final context stats 的目的是让 turn log 记录这次裁剪、压缩和 history limit 之后的最终上下文体积，方便后续排查“本轮结束后历史变成了什么状态”。

#### 设计理念

当前实现不把 stats 当成另一种裁剪策略。它只在所有 turn 后处理完成后重新估算一次 context，写入 `TurnLog`，用于观测和 metrics。

#### 细节

Turn 后最终会再次调用：

```python
build_llm_messages(
    state_data=self.state_data,
    current_turn_messages=[],
    system_prompt=system_prompt,
)
```

并写入：

- `turn_log.context_stats_after`
- `turn_log.prune_performed`
- `turn_log.prune_recovered_tokens`
- `turn_log.compaction_performed`

`turn_log.prune_performed` 和 `turn_log.prune_recovered_tokens` 仍保留在日志结构里用于兼容旧日志字段；当前 turn 前历史 tool result prune 已移除，正常新 turn 不会再由这条路径设置它们。

`_log_context_warnings()` 当前只按上下文使用率发 `[Turn:CONTEXT]` warning：当 `estimated_tokens / context_window > 0.8` 时提示接近 compaction threshold。tool result share warning 在当前代码里没有对应分支。
