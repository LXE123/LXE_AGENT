在 loop 进行过程中，项目内部是怎么接收模型供应商返回的 response 的？
- 流式接收，并不是等待模型供应商一次返回所有文本，而是流式读取

那么，该如何接收，
首先，明确 stream 模式下，response 发送回来的数据是怎么样的

以 kimicode 为例，kimi 使用的是 Anthropic Messages streaming 协议, 在请求体中添加 stream: true 会触发流式响应，

{
  "model": "kimi-code",
  "stream": true,
  "max_tokens": 32768,
  "system": "...",
  "messages": [...],
  "tools": [...],
  "tool_choice": { "type": "auto" }
}

流式响应 SSE 事件格式如下：

回复普通文本信息时：
```json
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","role":"assistant","content":[],"model":"kimi-code","usage":{"input_tokens":100,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}
```

需要工具调用：
```json
event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_xxx","name":"read","input":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"README.md\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}
```

sse 有多少种 event?
- message_start    // 消息开始发送了
- content_block_start   // 接下来的块是什么类型的，有 tool_use，text，thinking
- content_block_delta   // 实际的数据，普通文本是 text_delta，tool_use 是 input_json_delta，thinking 是 delta.thinking
- content_block_stop    // 所有的块发送完毕
- message_delta // 告知 stop reason，stop reason 有 end_turn，tool use，max_token
- message_stop // 消息发送完毕了
- error

一次 assistant 响应的 content 数组里可以包含 多个块，排列组合如下：

所有可能的组合
#	content 块组合	stop_reason	场景
1	[text]	end_turn	纯文本回复
2	[text, tool_use]	tool_use	先说一句话，再调工具
3	[text, tool_use, tool_use, ...]	tool_use	先说一句话，同时调多个工具
4	[tool_use]	tool_use	什么都不说，直接调工具
5	[tool_use, tool_use, ...]	tool_use	什么都不说，同时调多个工具
6	[thinking, text]	end_turn	思考后回复
7	[thinking, text, tool_use]	tool_use	思考后说话再调工具
8	[thinking, tool_use]	tool_use	思考后直接调工具
9	[thinking, tool_use, tool_use, ...]	tool_use	思考后同时调多个工具
10	[text]	max_tokens	文本被截断（达到 max_tokens 上限）


那么，如何接收这些数据？

下面是代码参考
```py
import json
import httpx


class StreamError(Exception):
    """流式响应中服务端返回的错误。"""
    pass


def stream_chat(api_key: str, messages: list, tools: list = None):
    """
    向 Kimi API 发送流式请求，逐块接收并解析 SSE 事件。
    """
    url = "https://api.kimi.com/coding/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
    }
    payload = {
        "model": "kimi-code",
        "stream": True,
        "max_tokens": 32768,
        "messages": messages,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = {"type": "auto"}

    with httpx.stream("POST", url, json=payload, headers=headers, timeout=120) as resp:
        resp.raise_for_status()

        text_content = ""
        tool_calls_by_index = {}    # index → tool call dict
        tool_input_buffers = {}     # index → partial JSON 字符串
        stop_reason = None
        usage = {}

        for line in resp.iter_lines():
            # ── SSE 协议过滤 ──
            if not line:                        # 空行（事件分隔符）
                continue
            if line.startswith(":"):            # SSE 注释（ping 心跳）
                continue
            if line.startswith("event: "):      # 记录事件类型（当前未使用）
                continue
            if not line.startswith("data: "):   # 不认识的行
                continue

            raw = line[6:]
            if not raw:
                continue

            data = json.loads(raw)
            event_type = data.get("type")

            # ── 0. error: 服务端错误 ──
            if event_type == "error":
                error_info = data.get("error", {})
                error_type = error_info.get("type", "unknown")
                error_msg = error_info.get("message", "")
                raise StreamError(f"{error_type}: {error_msg}")

            # ── 1. message_start: 拿到 usage（input_tokens） ──
            elif event_type == "message_start":
                msg = data.get("message", {})
                usage = msg.get("usage", {})

            # ── 2. content_block_start: 新块开始 ──
            elif event_type == "content_block_start":
                block = data["content_block"]
                idx = data["index"]
                if block["type"] == "tool_use":
                    tool_calls_by_index[idx] = {
                        "id": block["id"],
                        "name": block["name"],
                        "input": {},
                    }
                    tool_input_buffers[idx] = ""

            # ── 3. content_block_delta: 增量数据 ──
            elif event_type == "content_block_delta":
                idx = data["index"]
                delta = data["delta"]

                if delta["type"] == "text_delta":
                    text_content += delta["text"]

                elif delta["type"] == "input_json_delta":
                    tool_input_buffers[idx] += delta["partial_json"]

                elif delta["type"] == "thinking_delta":
                    pass  # thinking 碎片，按需处理

            # ── 4. content_block_stop: 当前块结束 ──
            elif event_type == "content_block_stop":
                idx = data["index"]
                if idx in tool_input_buffers:
                    raw_json = tool_input_buffers.pop(idx)
                    tool_calls_by_index[idx]["input"] = (
                        json.loads(raw_json) if raw_json else {}
                    )

            # ── 5. message_delta: stop_reason + output usage ──
            elif event_type == "message_delta":
                stop_reason = data["delta"].get("stop_reason")
                usage.update(data.get("usage", {}))

            # ── 6. message_stop: 结束 ──
            elif event_type == "message_stop":
                pass

    return {
        "text": text_content,
        "tool_calls": [
            tool_calls_by_index[k]
            for k in sorted(tool_calls_by_index)
        ],
        "stop_reason": stop_reason,
        "usage": usage,
    }

```

---

## 如何接收流式响应搞明白了，那么，如何围绕这个流式输出搭建 agent loop?

### 做一个 LLMResponse 模块处理所有流式事件
流式响应的返回的数据中需要抓取的可以分为 5 种
1. text
2. tool_use
3. thinking
4. stop_reason
5. 事件 message_delta 中的 usage 中的 input_tokens，output_tokens，cache_creation_input_tokens，cache_read_input_tokens
Anthropic Messages API 专用的 token 使用情况统计字段：
{
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50,
    "cache_creation_input_tokens": 200,
    "cache_read_input_tokens": 150
  }
}


### 如何存入对话上下文？
由于数据是断断续续过来的，我们不可能把所有这些数据碎片都存起来（毫无意义），所以只在完整的获取了一整条 message 时，才拼装起来存入上下文。

流式过程中：
  text_delta → 只记录，不写历史
  text_delta → 只记录，不写历史
  text_delta → 只记录，不写历史

message_end 时：
  完整的 assistant message → 写入 message

如果中途断流/取消：
  这条 assistant message 不存在，不写历史


### 如何接收多个 TOOL USE？
首先，什么时候认定 tool input json 已完成？
协议自带边界，content_block_stop 事件到达意味着 tool input json 接收完毕，可以开始调用工具。
多 tool_use 也一样，等 message_stop 后统一执行所有 tool_calls。

- 记得别忘了把 TOOL USE 入上下文中的 messages：

- 如何按照顺序调用，以及如何
答：根据 index

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_xxx","name":"read","input":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}


### 额外信息：Kimi 半截 JSON 实时修复
```js
// attempt.ts:1242-1253 — Kimi 半截 JSON 实时修复
if (shouldAttemptMalformedToolCallRepair(nextPartialJson, event.delta)) {
  const repair = tryParseMalformedToolCallArguments(nextPartialJson);
}

// handlers.messages.ts:177-184 — 重复文本实时检测
if (content.startsWith(ctx.state.deltaBuffer)) {
  chunk = content.slice(ctx.state.deltaBuffer.length);  // 只取增量
}
```

#### `tryParseMalformedToolCallArguments` 是什么

#### 问题背景

Kimi 返回 tool_use 的 JSON 参数时，有时会在**合法 JSON 后面多带几个垃圾字符**。比如：

```
正常应该返回：  {"path": "main.py"}
Kimi 实际返回：  {"path": "main.py"}abc
                                    ^^^  多了这几个字符
```

直接 `json.loads('{"path": "main.py"}abc')` → **崩溃**。

#### 这个函数做了什么

分三步：

```
第 1 步：直接尝试 json.parse(raw)
  ├─ 成功 → 返回 undefined（不需要修复，正常 JSON）
  └─ 失败 → 进入修复流程

第 2 步：extractBalancedJsonPrefix(raw)
  从头开始找到第一个完整的 { ... } 括号平衡体
  
  输入：  '{"path": "main.py"}abc'
  输出：  '{"path": "main.py"}'      ← 只取括号平衡的前缀
          剩余：'abc'                 ← 垃圾后缀

第 3 步：检查后缀是否合理
  ├─ 后缀长度 > 3 → 不修复（太长了，可能不是尾巴垃圾而是真的坏了）
  ├─ 后缀包含 {}[]":,\ → 不修复（看起来像结构字符，不敢动）
  └─ 后缀 ≤ 3 个普通字符 → 修复！把前缀 parse 成合法 JSON 返回
```

#### 源码对应

```typescript
function tryParseMalformedToolCallArguments(raw: string) {
  // 第 1 步：直接 parse，成功就不需要修
  try {
    JSON.parse(raw);
    return undefined;           // ← 正常 JSON，不修
  } catch {
    // 第 2 步：提取括号平衡的前缀
    const jsonPrefix = extractBalancedJsonPrefix(raw);
    //   '{"path":"main.py"}abc' → '{"path":"main.py"}'
    
    // 第 3 步：检查尾巴垃圾
    const suffix = raw.slice(jsonPrefix.length).trim();
    //   suffix = "abc"
    
    if (suffix.length > 3) return undefined;          // 太长，不修
    if (!/^[^\s{}[\]":,\\]{1,3}$/.test(suffix))       // 含结构字符，不修
      return undefined;
    
    // 安全修复：只 parse 前缀
    const parsed = JSON.parse(jsonPrefix);
    return { args: parsed, trailingSuffix: suffix };
    //       ↑ 修复后的参数    ↑ 被丢弃的垃圾
  }
}
```

#### 具体例子

```
输入：  '{"path": "main.py"}x'
         └── 合法 JSON ──┘ └ 1个垃圾字符

extractBalancedJsonPrefix → '{"path": "main.py"}'
suffix → 'x'
suffix.length = 1 ≤ 3 → 可修复
JSON.parse('{"path": "main.py"}') → { path: "main.py" }

返回：{ args: { path: "main.py" }, trailingSuffix: "x" }
日志：repairing Kimi tool call arguments after 1 trailing chars
```

```
输入：  '{"path": "main.py"}{"extra": true}'
         └── 合法 JSON ──┘ └── 太长，像另一个 JSON ──┘

suffix → '{"extra": true}'
suffix.length = 15 > 3 → 不修复
返回 undefined
```

#### 为什么只对 Kimi 启用

```typescript
// attempt.ts:1305-1307
function shouldRepairMalformedAnthropicToolCallArguments(provider?: string): boolean {
  return normalizeProviderId(provider ?? "") === "kimi";  // ← 只有 Kimi
}
```

这是 Kimi 的已知 bug，其他 provider（Anthropic、OpenAI）不会出现这个问题，所以不给它们启用，避免误修。

### 可中断
```js
// attempt.ts:2156-2158
abortSessionForYield = () => {
  yieldAbortSettled = Promise.resolve(activeSession.abort());
};

流式过程中可以随时 abort。用户发送 /stop，立即中断生成，不浪费 token。
```

### 引入观察机制，
这个观察机制是做什么的？
1. 把接收到的零碎字块通知前端。
分为 8 种事件处理
```js
// handlers.ts:24-64 — 事件处理器分发了 8 种事件
case "message_start":        → 通知 UI "正在输入..."
case "message_update":       → 推送 text_delta / thinking_delta
case "message_end":          → 记录 usage、去重、提取最终文本
case "tool_execution_start": → 通知 UI "正在执行 read main.py..."
case "tool_execution_end":   → 通知 UI 工具结果
case "agent_start":          → 记录 agent 启动
case "auto_compaction_start":→ 标记压缩中
case "auto_compaction_end":  → 标记压缩完成
```

文本描述：
把文本碎片实时推给前端（text_delta）
把思考过程实时推给前端（thinking_delta）
通知前端工具执行状态（tool_execution_start/end）
记录 usage 统计
处理去重（某些 provider 重发相同文本）
处理 Kimi 半截 JSON 修复


---

1. 流式数据的顺序由gateway决定，只要求当前的文本在上一次文本的基础上多出新的内容即可。 
2. 唯一处理的意外状态是出现 200850，会reopen卡片，其它错误别管。
3. reopen期间的流式数据累积起来，重新打开后再发给gateway，gateway继续正常打信号发给飞书用户。