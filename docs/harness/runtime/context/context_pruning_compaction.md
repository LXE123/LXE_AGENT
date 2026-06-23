# 上下文裁剪与压缩实现细节

状态：Current

## 目的

这篇文档解释当前 `AgentLoop` 如何在 turn 前、turn 内、turn 后控制上下文体积。读者如果在排查历史图片为什么消失、旧 tool result 为什么被清空或 head/tail trim、为什么某次 context overflow 后历史变成 summary、为什么 turn 结束后只保留最近若干 turn，应该读这一篇。

## 设计理念

上下文裁剪和压缩不是普通 prompt 组装，它们会改变后续 LLM 能看到的历史形态。当前实现采用三段式防线：turn 前先移除已经处理过的大体积历史内容，turn 内只在 provider 报 context overflow 时做恢复性压缩，turn 后再把完整本轮写入历史并进行持久化前后的长期治理。

## 链路位置

这一层贯穿 `AgentLoop.run()`：turn 前处理 `state_data.context.messages` 并构造本轮 messages；turn 内在 `_loop()` 中处理 LLM step overflow；turn 后追加本轮 messages，再做 compaction、history limit 和 final context stats。上下文基础格式见 [canonical_message.md](canonical_message.md)，turn 前组装链路见 [context_assembly.md](context_assembly.md)。

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
  -> build_llm_messages() probe
  -> prune_tool_results()
  -> build_llm_messages() final

turn 内:
  AgentLoop._loop()
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

当前没有 TTL 修剪机制。`prune_tool_results()` 保留 `now_ts` 参数，但函数体内直接忽略该参数；是否修剪只由当前上下文占比、字符数和阈值决定。

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

### Tool Result Hard Clear

#### 目的

Hard clear 的目的是在旧 tool result 已经占据上下文主体时快速止血，防止大段历史命令输出、网页抓取结果或结构化 payload 把本轮用户输入和近期对话挤出上下文。

#### 设计理念

当前实现先用“占比”和“总可修剪字符数”判断是否真的需要强清理。只有 tool result token share 超过硬阈值，并且累计可修剪内容足够大，才从旧到新清空内容。这样可以避免为几段不大的 tool output 过早牺牲历史可读性。

#### 细节

`prune_tool_results()` 在 turn 前执行。它只修改历史 messages 中 role 为 `tool`、block type 为 `tool_result` 的内容。

当前 hard clear 阈值：

| 常量 | 当前值 | 含义 |
| --- | ---: | --- |
| `TOOL_RESULT_HARD_SHARE` | `0.50` | tool result token 占总上下文 token 超过 50% 后尝试 hard clear |
| `MIN_PRUNABLE_TOOL_CHARS` | `50000` | hard clear 前要求所有可修剪 tool result 总字符数至少达到 50000 |

执行逻辑：

1. 用 `build_llm_messages()` 估算当前上下文总 token。
2. 收集历史 `tool_result` blocks，估算 tool result token 和字符数。
3. 如果 tool result share 大于 `0.50`，且可修剪 tool result 总字符数至少 `50000`，从旧到新处理。
4. 每个被处理的 tool result content 会被替换为 `[Old tool result content cleared]`。
5. 每清理一项都会重新估算当前 share；share 回到 `0.50` 以下后停止。

Hard clear 不会删除 `tool_result` block 本身，也不会删除 `tool_call_id`。它只替换 content，保证历史中的 tool call/result 结构仍然闭合。

### Tool Result Soft Trim

#### 目的

Soft trim 的目的是在 tool result 占比偏高但还没到强清理程度时，保留旧结果的头尾信息，让模型仍能看到“这个工具大概返回了什么”，同时减少中间大段内容的 token 成本。

#### 设计理念

当前实现采用 head/tail 保留策略，而不是摘要旧 tool result。这样处理成本低、稳定、不会额外调用 LLM，也不会引入总结失真。它牺牲中间细节，换取上下文预算和历史轮廓。

#### 细节

当前 soft trim 阈值：

| 常量 | 当前值 | 含义 |
| --- | ---: | --- |
| `TOOL_RESULT_SOFT_SHARE` | `0.30` | tool result token 占总上下文 token 超过 30% 后进入 soft trim |
| `TOOL_RESULT_TRIM_THRESHOLD_CHARS` | `4000` | 单个 tool result 内容小于 4000 字符时不做 head/tail trim |
| `TOOL_RESULT_TRIM_HEAD_CHARS` | `1500` | soft trim 保留头部字符数 |
| `TOOL_RESULT_TRIM_TAIL_CHARS` | `1500` | soft trim 保留尾部字符数 |

执行逻辑：

1. 如果 hard clear 后 share 仍大于 `0.30`，或一开始就大于 `0.30`，进入 soft trim。
2. 从旧到新遍历历史 tool result。
3. 已被 hard clear 成 `[Old tool result content cleared]` 的内容跳过。
4. 长度小于 `4000` 字符的内容跳过。
5. 符合条件的内容保留头部 `1500` 字符和尾部 `1500` 字符，中间插入 `...[trimmed]...`。
6. share 回到 `0.30` 以下后停止。

Turn 前 tool result prune 完成后，`AgentLoop.run()` 会重新调用 `build_llm_messages()`，本轮 LLM step 使用的是 prune 后的历史。

## Turn 内

Turn 内阶段发生在 `AgentLoop._loop()` 每个 LLM/tool step 之间。正常情况下，这一阶段不会周期性裁剪上下文；它只处理 provider 明确报出的 context overflow。

### Context Overflow Recovery

#### 目的

Context overflow recovery 的目的是在 provider 拒绝当前请求时，给本轮一次恢复机会。它尝试压缩旧历史，重建 messages，然后继续当前 step，而不是立刻把 overflow 暴露给用户。

#### 设计理念

当前实现把 overflow recovery 设计成“异常恢复”，不是常规压缩入口。它只压缩 `exec_ctx.state_data` 中的历史，不直接裁剪当前 turn messages。这样可以最大限度保留当前用户输入和本轮已经产生的 tool result，同时用旧历史摘要为本轮请求腾空间。

#### 细节

在 `_loop()` 中，如果一次 LLM step 抛出的异常被 `is_context_overflow_error()` 判断为上下文溢出，并且本 step 尚未做过 overflow recovery，会执行：

1. `maybe_compact_history(trigger="overflow")` 尝试压缩当前 `exec_ctx.state_data`。
2. 如果压缩成功，用新的 state 和当前 `current_turn_messages` 重新 `build_llm_messages()`。
3. 清掉上一段 stream summary。
4. 设置 `overflow_recovered = True`，继续当前 step 的下一次循环尝试。

同一轮 `_loop()` 中，成功收到一次 LLM response 后会把 `overflow_recovered` 重置为 `False`。如果 context overflow 后没有成功压缩，或已经恢复过但再次失败，则走普通 LLM error 分支，写入 error step，并返回错误回复。

`is_context_overflow_error()` 当前会识别：

- error 对象上的 `context_overflow=True`
- 文本中包含 `context overflow`、`context window`、`maximum context`、`too many tokens`、`prompt is too long`、`model token limit` 等提示

### Overflow Compaction

#### 目的

Overflow compaction 的目的是把旧历史压成一条 summary message，让当前 turn 能继续发送给 provider。它不是为了整理长期历史，而是为了从一次失败的 LLM request 中恢复。

#### 设计理念

Overflow compaction 复用 `maybe_compact_history()`，和 turn 后 compaction 使用同一套摘要机制。差别只在触发点：`trigger="overflow"` 发生在 LLM step 异常分支中，压缩成功后立即 rebuild messages 并重试当前 step。

#### 细节

`maybe_compact_history()` 的触发条件是：

```text
estimated_tokens > model_context_window_tokens - DEFAULT_RESERVE_TOKENS
```

当前默认值：

- `DEFAULT_CONTEXT_WINDOW_TOKENS = 256000`
- `DEFAULT_RESERVE_TOKENS = 20000`
- `RECENT_RAW_TURN_TOKEN_LIMIT = 20000`

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

---

目前 turn 内对上下文的管理还是太粗糙，已经出现了爆掉上下文窗口的情况。（最高一次到达大概 50 万 tokens，是 25 万上限的两倍。）
我要引入两个新的机制：
1. 对 tool_result 的裁剪。目前 agent loop 中，只要大模型返回 tool_use 类型的文本，那么当前 step 就一定会执行 tool。而 tool 的 result 的大小是不确定的，那么就需要我们做好管理准备。
触发时间段：tool result 回来后、下一次模型请求前。


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

post-turn compaction 使用和 overflow compaction 相同的阈值、recent raw turn token target 和 summary 写入形态：

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

`_log_context_warnings()` 当前只按上下文使用率发 `[Turn:CONTEXT]` warning：当 `estimated_tokens / context_window > 0.8` 时提示接近 compaction threshold。tool result share warning 在当前代码里没有对应分支。
