# LLM Integration

状态：Current

TypeScript provider 实现位于 [`packages/runtime/src/provider.ts`](/packages/runtime/src/provider.ts)。它使用 Anthropic Messages 兼容 SDK，负责 catalog、provider-specific message adaptation、thinking/redacted thinking、prompt cache、streaming、usage、timeout、错误分类和热切换。

- [Provider Catalog](provider_catalog.md)
- [Streaming Adapter](streaming_adapter.md)

每个 turn 获取一次 `RuntimeProviderSnapshot`。Dashboard 只有在新 client 验证成功且 `.env.local` 原子写入成功后才切换 generation；正在运行的 turn 不受影响。
