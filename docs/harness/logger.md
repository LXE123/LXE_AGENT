为了方便管理维护项目，一个好的日志系统




## Agent Loop 日志系统设计文档

### 一、设计目标

采集重要数据并且在正确的时机输出

---

### 二、日志分层设计

按一个 turn 的生命周期分 **三个时机**：

#### 1. `[Turn:START]` — Turn 开始时

**输出时机**：`AgentLoop.run()` 中，上下文快照构建完成后、进入 `_loop()` 前。

**格式**：
```
[Turn:START] session=abc123 user="你好" message_turns=0
  context={sys=1820, msg=85, total=1905, capacity=128000, usage=1.5%}
```

**字段说明**：

| 字段 | 含义 | 数据来源 |
|------|------|----------|
| `session` | 会话 ID | `TurnLog.session_id` |
| `user` | 用户输入前 50 字符 | `TurnLog.user_input_preview` |
| `message_turns` | message turn 数量 | `ContextBuildStats.raw_turn_count` |
| `sys` | system prompt 占 token 数 | `estimate_tokens(system_prompt)` |
| `msg` | messages 占 token 数 | `estimated_tokens - system_prompt_tokens` |
| `total` | 上下文总 token 数 | `ContextBuildStats.estimated_tokens` |
| `capacity` | 模型上下文窗口大小 | `_model_context_window_tokens()` |
| `usage` | 上下文使用率百分比 | `total / capacity * 100` |

**排查价值**：一眼判断是 prompt 太大还是历史太长。

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
[Turn:END] context_after={total=2100, usage=1.6%}
  delta=+195
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
| `delta` | 上下文 token 变化量（±） | `after - before` |

**排查价值**：判断上下文增长趋势。

---

### 三、TurnLog 新增字段

```python
# types.py — TurnLog dataclass 新增：
context_stats_before: ContextBuildStats | None = None   # turn 开始前上下文快照
context_stats_after: ContextBuildStats | None = None     # turn 结束后上下文快照
system_prompt_tokens: int = 0                            # system prompt token 数
context_window_tokens: int = 0                           # 模型上下文窗口大小
```

---

### 四、典型场景日志示例

#### 场景 A：简单问答（"你好"）

```
[Turn:START] session=a1b2c3 user="你好" message_turns=0
  context={sys=1820, msg=85, total=1905, capacity=128000, usage=1.5%}
[Turn:STEP] step=0 event=text_reply llm_latency=33400ms tokens_in=1905 tokens_out=85
[Turn:END] status=done elapsed=33822ms steps=1 llm_calls=1 tool_calls=0
  tokens_in=1905 tokens_out=85 tools=[]
[Turn:END] context_after={total=2100, usage=1.6%}
  delta=+195
```

**结论**：33.4s 全在 LLM API 延迟，prompt 只有 1905 token，代码链路开销 ~400ms。

#### 场景 B：多步工具调用

```
[Turn:START] session=d4e5f6 user="帮我打开百度搜索天气" message_turns=3
  context={sys=2100, msg=8500, total=10600, capacity=128000, usage=8.3%}
[Turn:STEP] step=0 event=tool_call llm_latency=2100ms tokens_in=10600 tokens_out=180 tool=browser_navigate
[Turn:STEP] step=0 event=tool_result tool=browser_navigate duration=3200ms success=True
[Turn:STEP] step=1 event=tool_call llm_latency=1800ms tokens_in=12400 tokens_out=150 tool=browser_type
[Turn:STEP] step=1 event=tool_result tool=browser_type duration=800ms success=True
[Turn:STEP] step=2 event=text_reply llm_latency=1500ms tokens_in=13800 tokens_out=220
[Turn:END] status=done elapsed=11200ms steps=5 llm_calls=3 tool_calls=2
  tokens_in=36800 tokens_out=550 tools=['browser_navigate', 'browser_type']
[Turn:END] context_after={total=14500, usage=11.3%}
  delta=+3900
```

**结论**：总 11.2s，LLM 共 5.4s，工具共 4s，开销 ~1.8s。
