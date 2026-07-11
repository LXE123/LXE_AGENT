# Context Pruning and Compaction

状态：Current

ContextPipeline 使用模型 catalog 的 context window，默认预留 20k output token，并在 90% 时触发摘要。普通历史保留最近约 20k token 的完整 turns；单 turn 过长时保留原始用户请求与最近工具步骤，总结较早中间步骤。

每个工具步骤的文本结果共享 10k token 预算，UTF-8 安全地保留首尾；图片块不计入文本预算。turn 完成后，已处理的历史 base64 图片替换为占位。

摘要使用当前 provider、禁用 tools/thinking，最多两次。只有 token 确实下降才写 replacement checkpoint；失败或空摘要保持原始历史并显式终止，不会使用本地伪摘要或静默删除消息。provider overflow 只允许强制压缩后重试一次。
