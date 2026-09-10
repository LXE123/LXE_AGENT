# Streaming Adapter

三类 Provider 使用各自的协议适配器，将响应归一化为共享 AssistantMessage 和流事件。选择入口见 [LLM 适配](README.md)，完整内容索引与事件契约见 [统一模型消息流](../assistant-message-stream.md)。

## 输入与输出

每次调用使用固定的 system、canonical history、可见工具、provider/model、推理设置、输出上限和取消信号。适配器不发现 Skills、不执行工具，也不直接持久化会话。

协议事件累计为文本、思考和工具调用内容，保留稳定的内容索引、调用 ID、参数、usage 和停止原因。Runtime 消费统一事件生成桌面或渠道展示，收到完整消息后再进入工具执行或 final。

## 协议专属处理

- **Anthropic Messages**：消费 SDK 的原始 streamEvent，包括 content_block_start 和后续 delta；由 AnthropicMessagesStreamAdapter 累计 block，保留该协议允许的 signature 和 redacted thinking。这个事件名称不适用于 OpenAI 两类接口。
- **OpenAI Completions**：累计增量正文、推理字段和按 index 分段的 tool_calls；reasoning 字段差异由已验证的模型描述控制。
- **OpenAI Responses**：按 item ID、output index 和 content index 关联内容，done 事件校正最终值；tool call ID 与供应商 item ID 分开保存。

历史中的不透明签名、item ID 等只在来源匹配时重放。适配发生在请求视图中，持久化的 canonical transcript 保持原有内容。

## 取消、超时与失败

调用方 abort 会结束当前流，不作为普通传输错误重试。Provider 的空闲 watchdog 使用已验证的 descriptor 时限，默认 120 秒，连接与流活动会重置计时；它约束无响应间隔，不是整个回合的总时限，也不适用于等待用户回答。

普通可重试失败由 Runtime step loop 最多尝试三次；认证、权限、非法请求和取消不会盲目重试。上下文溢出走独立的压缩与恢复路径，不能只重复发送同一份过大请求。具体策略见 [Turn Execution](../runtime/turn_execution.md)。

协议归一化失败必须使本次请求失败，不能伪装成空白成功。写 trace 的失败与业务解析失败分开：诊断写入错误不应破坏模型调用，实际协议解析错误则保留诊断并终止该请求。

## 诊断与持久化

日志和 wire trace 对凭据、Cookie、签名、不透明推理数据、base64 和过长载荷做脱敏及截断。可读的文本或思考增量可能出现在显式启用的诊断 trace 中，详见 [日志契约](../logger.md)。

Transcript 为后续 replay 保存必要的模型内容；它不是日志脱敏后的副本。用户展示、模型上下文和诊断输出分别处理，错误不得用无事实依据的通用提示覆盖。
