TOOL 由纯代码构成


---

并未确定使用的 TOOL，在 prompt 的格式如下（）：
- image: Analyze an image with the configured image model
- web_search: Search the web (Brave API)
- exec: Run shell commands with optional background sessions
- process: Manage running or finished exec sessions
- 写入 system prompt 有两种方式
1. 直接硬编码在 system propmt 中
2. 直接读取 TOOL 本身参数

确定要使用完整时获取 TOOL 的参数，
“{
    "name": "image",
    "description": "Analyze an image with the configured image model",
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": { "type": "string" },
            "image": {
                "type": "string",
                "description": "Single image path or URL."
            },
            "images": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Multiple image paths or URLs (up to maxImages, default 20)."
            }
        }
    }
}

然后 agent 生成下面的数据格式发送给 LLM：
```json
{
  "model": "claude-opus-4-6",
  "system": "You are OpenClaw...\n- image: Analyze an image...",
  "messages": [...],
  "tools": [
    {
      "name": "image",
      "description": "Analyze an image...",
      "parameters": {
        "type": "object",
        "properties": {
          "prompt": { "type": "string" },
          "image":  { "type": "string" }
        }
      }
    },
    { "name": "exec", ... },
    { "name": "process", ... },
    { "name": "web_search", ... }
  ]
}
```
怎么组装的？
每个字段的来源：
```json
{
  "model":    "← OpenClaw 配置文件决定",
  "system":   "← OpenClaw 拼接（硬编码 prompt + bootstrap files + skills + 等等）",
  "messages": "← 历史记录，内容由 AI 和用户共同产生，OpenClaw 负责存储和拼上去",
  "tools":    "← OpenClaw 从 tool 对象读取 name/description/parameters 拼上去"
}
```

---
LLM 会直接返回一个 tool call 格式化数据：
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "name": "image",
      "input": { "image": "/tmp/foo.png", "prompt": "描述这张图" }
    }
  ]
}
```

然后客户端执行对应的 `execute()` 函数，把结果再放进 `messages` 更新上下文继续下一次 loop。

---

### 做一个 agent 讲究的就是有条有理的数据格式。
所以我在此决定继续格式化 TOOL 的返回数据 

首先，每个工具都必须返回一个 object，其中有两个字段 content（数组）和 details
content 的格式大概如下：
 [
    { type: "text", text: "MEDIA:/path/to/logo.png" },
    { type: "image", data: "base64...", mimeType: "image/png" }
],
做成这种格式的原因之一是为了专门对 tool result 在上下文中的格式做适配（即开即用）

details 是一个 object，只存入系统需要的东西，字段名，格式都自定义，所以大部分情况可直接为空

---

在 agent 系统中，一个很重要的理念就是 AI 占据最大的主动权，所以 content 里的东西最好就是 tool 直出的数据。
