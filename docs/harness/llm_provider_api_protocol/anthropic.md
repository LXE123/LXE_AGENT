目前该框架用 anthropic 协议的最多的是 kimi-code，那就以 kimi 为例

---

发送请求的格式大概是这样：
POST https://api.kimi.com/coding/v1/messages
发送的请求头：
{
    
    content-type: application/json
    x-api-key: <KIMI_CODE_API_KEY>
    User-Agent: claude-code/0.1.0
    anthropic-version: 2023-06-01
}

发送的 payload：
{
  "model": "kimi-code",
  "max_tokens": 32768,
  "system": "## Soul\n...\n\n## Tool Summaries\n...",
  "messages": [
    {
      "role": "user",
      "content": "用户输入内容"
    },
    ...
  ],
  "stream": true,
  "thinking": {
    "type": "enabled"  // 有 enabled 和 disabled
  },
  "tools": [
    {
      "name": "read",
      "description": "Read file content",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          }
        },
        "required": ["path"]  // 必填参数
      }
    },
    ...
  ],
  "tool_choice": {
    "type": "auto" // 有 auto 和 none
  }
}

---

现在有一个问题，目前我发送请求的方式是手写的请求，返回的数据也是手写接收的。如果要改成 anthropic SDK 的话可能会造成很大的改动，但是我认为还是要改，因为目前有这么多个协议，openAI，codex，anthropic，以及其它的模型供应商，我不可能一个一个手写过去。

---

好的，先从 anthropic SDK 开始做起，我们分为两个部分，发送请求和接收响应。

我的计划是这样：
1. 先把 anthropic sdk 接入我的项目，然后直接使用发消息不做任何处理，看看会发生什么报错
2. 一个一个报错解决
3. 适配我目前的框架
4. 如果做的好，可以删除目前手写的

先从第一步开始，
目前我们项目已经处理好了从基础格式转化为 anthropic message 的格式，这部分应该不用动，
那么我们应该就是要用这个转化好的 anthropic message 格式去通过 anthropic SDK 发送请求
好的，基础版的请求格式如下：
```py
from anthropic import Anthropic

client = Anthropic(
    api_key=descriptor.api_key,
    base_url=descriptor.base_url.rstrip("/") if descriptor.base_url else None,
)

kwargs = {
    "model": descriptor.default_model,
    "max_tokens": max(256, int(max_tokens)),
    "messages": messages,
}

if system_prompt and system_prompt.strip():
    kwargs["system"] = system_prompt.strip()

if tool_choice_mode != "none" and tool_schemas:
    kwargs["tools"] = tool_schemas
    kwargs["tool_choice"] = {"type": "auto"}

with client.messages.stream(**kwargs) as stream:
    for event in stream:
        ...
```
如何发送一个准确基础版 anthropic 协议请求的用正常语言来说就是
1. 接入 anthropic SDK
2. 准备好 API_key 和 base_url （请求的目标 url，其实如果是真正的原生这个 base_url 也不用准备）
3. payload 中的上下文可以分为 system、messages、tools。
system 是顶层字段，不放进 messages。
messages 需要是 Anthropic Messages 格式，content 可以是 text/image/document/tool_result 等 block。
tools 需要是 Anthropic tool schema 格式；如果上层 tool_choice_mode 是 none，则不发送 tools 和 tool_choice。
4. payload 中的其它字段。tool_choice，max_tokens，model。其中 tool_choice 有两个属性，none 和 auto。max_tokens，model 取决于模型供应商的说明，需要自己去找。
5. stream。流式有两种表达：一种是底层/普通 create 写法里传 stream=True；另一种是 Anthropic SDK 提供的 messages.stream(...)。二选一。推荐 messages.stream(...)，因为它是官方流式封装，方便处理事件流、连接生命周期和最终消息。

- 这里补充一下发送响应时 message 独有的 3 种（image、document 由用户的输入转化成的，tool_result 是工具执行结果）
**image block**
```python
    block.type                    # "image"
    block.source.type             # "base64" | "url" | "file"

    # base64 方式
    block.source.media_type       # "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    block.source.data             # "/9j/4AAQSkZJRg..."  ← base64 字符串

    # url 方式
    block.source.url              # "https://example.com/image.jpg"

    # file 方式（Files API 上传后）
    block.source.file_id          # "file_011CNha..."
```

**document block**
```python
    block.type                    # "document"
    block.source.type             # "base64" | "text" | "url" | "file"

    # file 方式（最常用）
    block.source.file_id          # "file_011CNha..."

    # base64 方式
    block.source.media_type       # "application/pdf"
    block.source.data             # "JVBERi0xLjQK..."  ← base64 字符串

    # 可选字段
    block.title                   # "Q3 Report"         ← 可选
    block.context                 # "这是第三季度报告"    ← 可选
```

**tool_result block**
```python
    block.type                    # "tool_result"
    block.tool_use_id             # "toolu_01xxx"  ← 对应 tool_use block 的 id
    block.content                 # "北京今天晴，25°C"  ← 字符串，或 block 列表
    block.is_error                # True | False       ← 可选，工具执行失败时传 True
```

---

注意 `tool_result.content` 比较特殊，可以是**字符串**，也可以是**嵌套 block 列表**（比如工具返回了图片）：

```python
# 简单文本结果
block.content   # "气温 25°C"

# 复杂结果（嵌套）
block.content   # [{"type": "text", "text": "..."}, {"type": "image", ...}]
```

---


基础版的解析响应：
遍历 response.content
按 block.type 分流
text       → content
tool_use   → tool_calls
thinking   → reasoning_content
usage      → token 统计
stop_reason → 判断是否需要执行工具
先来说说这个 response.content，这是一个列表，里面有很多 block，block 有多种 type。response.content 的结构和 block 的分类如下：

## 结构示意

```
response.content = [
    block_0,   # 比如 thinking block
    block_1,   # 比如 text block
    block_2,   # 比如 tool_use block
]
```

---

## block 分类

block 是 Anthropic SDK 返回的 **Python 对象**（不是 dict），用 `getattr` 取属性。

不同 `type` 的 block 长这样：
（text，tool_use，thinking，redacted_thinking）
**text block**
```python
block.type      # "text"
block.text      # "好的，我来查。"
```

**tool_use block**
```python
block.type      # "tool_use"
block.id        # "toolu_01xxx"
block.name      # "search"
block.input     # {"query": "weather"}  ← 已经是 dict，不是字符串
```

**thinking block**
```python
block.type       # "thinking"
block.thinking   # "用户想查天气，我应该调用search工具..."
block.signature  # "EqoBCkgI..."  ← 可选，Anthropic用来验证思维链完整性
```

**redacted_thinking block**
```python
block.type   # "redacted_thinking"
block.data   # "EnoBCk..."  ← 加密数据，内容不可读
```

---

## 为什么用 `getattr` 而不是直接 `.属性`

代码里写的是：
```python
getattr(block, "text", "")
```
而不是：
```python
block.text
```

原因是**防御性编程**——不同类型的 block 属性不同，比如 `text block` 没有 `.input`，直接访问会报 `AttributeError`，用 `getattr` 设默认值更安全。
```py

知道了怎么解析响应返回的 content，以及其中的 block。下一步就是说说流式和非流式都有什么不同了。
1. 非流式
response = client.messages.create(...)

拿到的是完整 message：

response.content
response.stop_reason
response.usage

你可以直接遍历：

for block in response.content:
    ...
所以非流式处理是比较简单的，直接有完整的 block 可以解析

2. 流式
stream = client.messages.create(..., stream=True)

拿到的是一串事件：

event.type:
  message_start
  content_block_start
  content_block_delta
  content_block_stop
  message_delta
  message_stop

你要边读边累积：

for event in stream:
    ...

各个 event 解释：
1. message_start // 一条 assistant message 开始了。

```py
if event.type == "message_start":
    message_id = event.message.id
    model = event.message.model
    role = event.message.role
    usage = event.message.usage
```

2. content_block_start  // 一个新的 content block 开始了。
```py
if event.type == "content_block_start":
    index = event.index
    block = event.content_block

    if block.type == "text":
        # 一个文本 block 开始
        pass

    elif block.type == "tool_use":
        # 一个工具调用 block 开始
        tool_id = block.id
        tool_name = block.name

    elif block.type == "thinking":
        # 一个 thinking block 开始
        pass
```

3. content_block_delta  // 当前 content block 新增了一小段内容
有三种类型 text / tool_use / thinking

4. content_block_stop   // 当前 content block 结束了

5. message_delta    // 整条 assistant message 的元信息更新。

6. message_stop // 整条 assistant message 结束。

还有不同的 delta：
delta.type:
  text_delta
  input_json_delta
  thinking_delta
  signature_delta
  citations_delta


关于 event 和 delta 的关系：
1. event 是流式协议的外层帧；delta 是帧里携带的局部增量数据。
2. 不是所有 event 都会有 delta，delta 只会出现在以下 event 中 content_block_delta 和 message_delta
3. 


---

问：关于 tool_use，一轮响应中可能会遇到多个 tool_use，那么这个 tool_use 是不是在流式过程中（比如说刚解析完第一个）就开始执行 tool 呢？
答：不会，只有在接收所有响应后才会开始依次执行 tool。