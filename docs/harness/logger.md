为了方便管理维护项目，一个好的日志系统




## Agent Loop 日志系统设计文档

### 一、设计目标

采集重要数据并且在正确的时机输出

---

### 二、日志分层设计

按一个 turn 的生命周期分 **三个时机 + 一个条件预警**：

#### 1. `[Turn:START]` — Turn 开始时

**输出时机**：`AgentLoop.run()` 中，prune + `build_llm_messages` 完成后、进入 `_loop()` 前。

**格式**：
```
[Turn:START] session=abc123 user="你好" history_turns=0
  context={sys=1820, msg=85, total=1905, capacity=128000, usage=1.5%}
  tool_result={tokens=0, share=0.0%}
```

**字段说明**：

| 字段 | 含义 | 数据来源 |
|------|------|----------|
| `session` | 会话 ID | `TurnLog.session_id` |
| `user` | 用户输入前 50 字符 | `TurnLog.user_input_preview` |
| `history_turns` | 历史 turn 数量 | `ContextBuildStats.raw_turn_count` |
| `sys` | system prompt 占 token 数 | `estimate_tokens(system_prompt)` |
| `msg` | messages 占 token 数 | `estimated_tokens - system_prompt_tokens` |
| `total` | 上下文总 token 数 | `ContextBuildStats.estimated_tokens` |
| `capacity` | 模型上下文窗口大小 | `_model_context_window_tokens()` |
| `usage` | 上下文使用率百分比 | `total / capacity * 100` |
| `tool_result.tokens` | tool result 占 token 数 | `ContextBuildStats.tool_result_tokens` |
| `tool_result.share` | tool result 占总 token 比例 | `ContextBuildStats.tool_result_share` |

**排查价值**：一眼判断是 prompt 太大、历史太长、还是 tool result 膨胀。

---

#### 2. `[Turn:STEP]` — 每个 Step 结束时

**输出时机**：`_loop()` 中，每次 `turn_log.steps.append(step_log)` 之后立即输出。

**格式（LLM 响应类）**：
```
[Turn:STEP] step=0 event=text_reply llm_latency=33400ms tokens_in=1905 tokens_out=85
[Turn:STEP] step=0 event=tool_call llm_latency=2100ms tokens_in=5200 tokens_out=340 tool=browser_navigate
[Turn:STEP] step=1 event=llm_error llm_latency=0ms tokens_in=0 tokens_out=0
```

**格式（工具执行类）**：
```
[Turn:STEP] step=0 event=tool_result tool=browser_navigate duration=1200ms success=True
[Turn:STEP] step=1 event=tool_error tool=run_script duration=5000ms success=False
```

**字段说明**：

| 字段 | 含义 | 适用事件 |
|------|------|----------|
| `step` | 循环迭代序号（0-based） | 所有 |
| `event` | 事件类型 | 所有 |
| `llm_latency` | LLM API 响应耗时 | `text_reply`, `tool_call`, `llm_error` |
| `tokens_in` | 本次 LLM 调用输入 token | `text_reply`, `tool_call`, `llm_error` |
| `tokens_out` | 本次 LLM 调用输出 token | `text_reply`, `tool_call`, `llm_error` |
| `tool` | 工具名称 | `tool_call`, `tool_result`, `tool_error` |
| `duration` | 工具执行耗时 | `tool_result`, `tool_error` |
| `success` | 工具是否成功 | `tool_result`, `tool_error` |

**event 取值**：

| event | 含义 |
|-------|------|
| `text_reply` | LLM 返回纯文本回复，turn 结束 |
| `tool_call` | LLM 请求调用工具 |
| `tool_result` | 工具执行成功返回结果 |
| `tool_error` | 工具执行失败 |
| `llm_error` | LLM API 调用失败 |

**排查价值**：精确定位每步耗时，区分"LLM 慢"还是"工具慢"。

---

#### 3. `[Turn:END]` — Turn 结束时（两行）

**输出时机**：`AgentLoop.run()` 末尾，`turn_log.finalize()` 之后。

**格式**：
```
[Turn:END] status=done elapsed=33822ms steps=1 llm_calls=1 tool_calls=0
  tokens_in=1905 tokens_out=85 tools=[]
[Turn:END] context_after={total=2100, usage=1.6%, tool_share=0.0%}
  delta=+195 prune=False(recovered=0) compaction=False
```

**第一行 — 核心指标**：

| 字段 | 含义 | 数据来源 |
|------|------|----------|
| `status` | turn 结果状态 | `TurnLog.status`（done/error/cancelled） |
| `elapsed` | turn 总耗时 | `TurnLog.elapsed_ms` |
| `steps` | 总步数 | `len(TurnLog.steps)` |
| `llm_calls` | LLM 调用次数 | `TurnLog.total_llm_calls` |
| `tool_calls` | 工具调用次数 | `TurnLog.total_tool_calls` |
| `tokens_in` | 累计输入 token | `TurnLog.total_input_tokens` |
| `tokens_out` | 累计输出 token | `TurnLog.total_output_tokens` |
| `tools` | 使用的工具列表 | `TurnLog.tools_used` |

**第二行 — 上下文变化**：

| 字段 | 含义 | 数据来源 |
|------|------|----------|
| `context_after.total` | turn 结束后上下文总 token | `context_stats_after.estimated_tokens` |
| `context_after.usage` | 结束后上下文使用率 | `total / capacity * 100` |
| `context_after.tool_share` | 结束后 tool result 占比 | `context_stats_after.tool_result_share` |
| `delta` | 上下文 token 变化量（±） | `after - before` |
| `prune` | 是否执行了 tool result 清理 | `TurnLog.prune_performed` |
| `recovered` | 清理回收的 token 数 | `TurnLog.prune_recovered_tokens` |
| `compaction` | 是否触发了上下文压缩 | `TurnLog.compaction_performed` |

**排查价值**：判断上下文增长趋势，追踪 prune/compaction 是否生效。

---

#### 4. `[Turn:CONTEXT]` — 条件预警

**触发条件**：

| 条件 | 阈值 | 含义 |
|------|------|------|
| 上下文使用率超过 80% | `estimated_tokens / capacity > 0.8` | 即将触发压缩 |
| tool result 占比超过 50% | `tool_result_share > 0.5` | tool result 膨胀 |

**格式**：
```
[Turn:CONTEXT] ⚠ token usage 82% (105000/128000) — approaching compaction threshold
[Turn:CONTEXT] ⚠ tool_result share 55% (57750 tokens) — consider pruning
```

**日志级别**：`WARNING`（其余均为 `INFO`）。

---

### 三、数据流

```
                          prune_tool_results()
                                │
                                ▼
                     build_llm_messages() ──→ context_stats (before)
                                │
                     ┌──────────┴──────────┐
                     ▼                      ▼
              [Turn:START]          [Turn:CONTEXT] ⚠
                     │
                     ▼
              ┌─── _loop() ───┐
              │  step 0        │ ──→ [Turn:STEP] event=tool_call
              │  step 0        │ ──→ [Turn:STEP] event=tool_result
              │  step 1        │ ──→ [Turn:STEP] event=text_reply
              └────────────────┘
                     │
                     ▼
            maybe_compact_history()
            apply_history_turn_limit()
                     │
                     ▼
            build_llm_messages() ──→ context_stats (after)
                     │
                     ▼
              turn_log.finalize()
                     │
                     ▼
               [Turn:END] (两行)
```

---

### 四、TurnLog 新增字段

```python
# types.py — TurnLog dataclass 新增：
context_stats_before: ContextBuildStats | None = None   # turn 开始前上下文快照
context_stats_after: ContextBuildStats | None = None     # turn 结束后上下文快照
system_prompt_tokens: int = 0                            # system prompt token 数
context_window_tokens: int = 0                           # 模型上下文窗口大小
prune_performed: bool = False                            # 是否执行了 tool result 清理
prune_recovered_tokens: int = 0                          # 清理回收 token 数
compaction_performed: bool = False                       # 是否触发了上下文压缩
```

---

### 五、典型场景日志示例

#### 场景 A：简单问答（"你好"）

```
[Turn:START] session=a1b2c3 user="你好" history_turns=0
  context={sys=1820, msg=85, total=1905, capacity=128000, usage=1.5%}
  tool_result={tokens=0, share=0.0%}
[Turn:STEP] step=0 event=text_reply llm_latency=33400ms tokens_in=1905 tokens_out=85
[Turn:END] status=done elapsed=33822ms steps=1 llm_calls=1 tool_calls=0
  tokens_in=1905 tokens_out=85 tools=[]
[Turn:END] context_after={total=2100, usage=1.6%, tool_share=0.0%}
  delta=+195 prune=False(recovered=0) compaction=False
```

**结论**：33.4s 全在 LLM API 延迟，prompt 只有 1905 token，代码链路开销 ~400ms。

#### 场景 B：多步工具调用

```
[Turn:START] session=d4e5f6 user="帮我打开百度搜索天气" history_turns=3
  context={sys=2100, msg=8500, total=10600, capacity=128000, usage=8.3%}
  tool_result={tokens=3200, share=30.2%}
[Turn:STEP] step=0 event=tool_call llm_latency=2100ms tokens_in=10600 tokens_out=180 tool=browser_navigate
[Turn:STEP] step=0 event=tool_result tool=browser_navigate duration=3200ms success=True
[Turn:STEP] step=1 event=tool_call llm_latency=1800ms tokens_in=12400 tokens_out=150 tool=browser_type
[Turn:STEP] step=1 event=tool_result tool=browser_type duration=800ms success=True
[Turn:STEP] step=2 event=text_reply llm_latency=1500ms tokens_in=13800 tokens_out=220
[Turn:END] status=done elapsed=11200ms steps=5 llm_calls=3 tool_calls=2
  tokens_in=36800 tokens_out=550 tools=['browser_navigate', 'browser_type']
[Turn:END] context_after={total=14500, usage=11.3%, tool_share=35.1%}
  delta=+3900 prune=False(recovered=0) compaction=False
```

**结论**：总 11.2s，LLM 共 5.4s，工具共 4s，开销 ~1.8s。

#### 场景 C：上下文即将爆满 + 自动清理

```
[Turn:START] session=g7h8i9 user="继续上一步操作" history_turns=15
  context={sys=2100, msg=108000, total=110100, capacity=128000, usage=86.0%}
  tool_result={tokens=62000, share=56.3%}
[Turn:CONTEXT] ⚠ token usage 86% (110100/128000) — approaching compaction threshold
[Turn:CONTEXT] ⚠ tool_result share 56% (62000 tokens) — consider pruning
[Turn:STEP] step=0 event=text_reply llm_latency=4200ms tokens_in=110100 tokens_out=300
[Turn:END] status=done elapsed=5100ms steps=1 llm_calls=1 tool_calls=0
  tokens_in=110100 tokens_out=300 tools=[]
[Turn:END] context_after={total=85000, usage=66.4%, tool_share=28.1%}
  delta=-25100 prune=True(recovered=25100) compaction=False
```

**结论**：上下文 86% 即将爆，prune 回收了 25100 token。下一轮如果继续增长会触发 compaction。

---

### 六、阈值配置

```python
# loop.py
_CONTEXT_USAGE_WARN_THRESHOLD = 0.8    # 上下文使用率超过 80% 发 WARNING
_TOOL_RESULT_SHARE_WARN_THRESHOLD = 0.5 # tool result 占比超过 50% 发 WARNING
```

这两个值是 `loop.py` 中的模块级常量，改值不需要改函数逻辑。

---
