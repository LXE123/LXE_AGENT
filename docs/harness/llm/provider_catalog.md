# Provider Catalog

状态：Current

Provider 描述文件位于 [`packages/runtime/config/providers`](/packages/runtime/config/providers)，由 `loadProviderDescriptor()` 读取。descriptor 是 model、base URL、鉴权 env、context window、thinking 与 request timeout 的单一事实源，同时供 ContextPipeline、summary、CardKit metrics 和 Dashboard 使用。

Kimi/DeepSeek 的 message adaptation 在 provider 层完成。DeepSeek 不接收不支持的 thinking signature、encrypted redacted payload 或 base64 history image；canonical transcript 本身仍保留兼容数据。
