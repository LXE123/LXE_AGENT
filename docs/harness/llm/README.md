# LLM 适配

Provider 层把 Runtime 的统一消息转换成供应商请求，再把流式响应转成统一模型消息。当前支持三类协议，由 [provider-factory.ts](/packages/agent/runtime/src/providers/provider-factory.ts) 根据目录中的 apiStyle 选择：

| 协议 | 适配器 |
| --- | --- |
| Anthropic Messages | [provider.ts](/packages/agent/runtime/src/providers/provider.ts) 中的 AnthropicRuntimeProvider |
| OpenAI Chat Completions | [completions-provider.ts](/packages/agent/runtime/src/providers/completions-provider.ts) |
| OpenAI Responses | [responses-provider.ts](/packages/agent/runtime/src/providers/responses-provider.ts) |

## 职责与请求流程

1. 回合开始时获取 provider/model 与凭据快照；配置更新影响后续回合。
2. ContextPipeline 生成 canonical history 和本 step 可见工具，估算上下文预算。
3. 所选适配器转换消息、工具 schema、图片和推理控制，并按来源限制不透明字段的重放。
4. 发起对应协议的流请求，归一化文本、思考、工具参数、usage 和结束状态。
5. Runtime 根据完整响应执行工具、返回答案、重试或进入上下文溢出恢复。

Provider 不执行工具，不持有会话数据库，也不决定桌面或飞书的最终发送位置。请求适配不改写持久化 transcript。

## 专题

- [Provider Catalog](provider_catalog.md)：模型目录、能力、凭据和公司模型选择。
- [云端模型描述 v3](managed-model-catalog.md)：动态模型定义、客户端校验和发布兼容。
- [Streaming Adapter](streaming_adapter.md)：协议事件归一化、取消、超时与错误。
- [统一模型消息流](../assistant-message-stream.md)：三类协议共享的内容与事件契约。
- [Runtime Context](../runtime/context/README.md)：模型历史、预算与压缩。
- [Tool Schema](../runtime/tools/tool_schema.md)：工具定义和暴露范围。

## 排障

先区分配置错误、请求格式不支持、传输失败、上下文溢出和工具历史不闭合。错误保留脱敏、显式截断后的实际诊断；不要把所有失败归结为网络或权限问题。认证信息及不透明推理数据不得原样进入日志，具体日志边界见 [Logging](../logger.md)。
