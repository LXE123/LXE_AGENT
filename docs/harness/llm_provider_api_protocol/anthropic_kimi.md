目前项目中对 anthropic SDK 进行了适配，有基础的发送请求和接收响应。

那么当使用 kimi-code 时，需要对 请求 和 响应 做一些独特的适配

请求部分：
1. 自定义 User-Agent: claude-code/0.1.0

2. 请求体中默认不带 thinking 字段，因为：
```python
# Kimi 的 /coding 端点使用 Anthropic Messages 协议，
# 但它有自己的 thinking 语义：
# 当发送 thinking.enabled 时，Kimi 会校验消息历史，
# 并要求之前每一条 assistant 工具调用消息都携带
# OpenAI 风格的 reasoning_content。
#
# 但 Anthropic 路径本身不会填充这个字段，
# 而且 convert_messages_to_anthropic 在第三方端点上
# 会移除所有 Anthropic thinking blocks。
#
# 所以请求会失败，返回 HTTP 400：
# "thinking is enabled but reasoning_content is missing in assistant
# tool call message at index N"
#
# 在 /coding 路由上，Kimi 的 reasoning 是由服务端驱动的，
# 因此对于这个 host，应完全跳过 Anthropic 的 thinking 参数。
#
# 至于 Kimi 的 chat_completions 路径，
# 它是在 ChatCompletionsTransport 里通过 extra_body 启用 thinking 的；
# 参见 #13503。
```
3. model
kimi-code 有以下 model 可以选择
kimi-for-coding

4. max_tokens
不用管，用 anthropic_sdk 默认的就行

---

响应部分：
无