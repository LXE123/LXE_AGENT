ToolSchema 会在向 LLM 发送请求时，与 system prompt 和 messages 一起作为请求体的顶层字段发送给模型，用于展示工具的参数格式和介绍。

toolshecma 是否有固定的格式？有，如下：
- name  # 工具名
- description   # 介绍
- parameters    # 参数

虽然在内部只有一种 canonical ToolSchema 但在真正发送给模型 API 时，会分出两种格式
- 一种是 Anthropic 风格：
{
    "name":"read",
    "description":"...",
    "input_schema":{...}
}
- 另一种是 OpenAI function calling 风格：
{
    "type":"function",
    "function":{
        "name":"read",
        "description":"...",
    "parameters":{...}
    }
}

如何组装进入上下文呢？
已知上下文本来由 system prompt 和 massage 组成。
里面具体的细节可以看 docs\harness\contextmanagement\contextManagement.md
组装的方法就是直接作为第三部分添加
{
    system prompt: ,    # 字符串
    messages: ,  # 数组
    tools: ,    # 数组，这里就是展示所有 tool schema 的地方，根据 OpenAI function calling 和 Anthropic 的协议在格式上有一些变化
}