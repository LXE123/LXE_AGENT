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
目前我们项目已经处理好了从基础格式转化为 anthropic message 的格式，这部分应该不用动
那么我们应该就是要用这个转化好的 anthropic message 格式去通过 anthropic SDK 发送请求，对吗