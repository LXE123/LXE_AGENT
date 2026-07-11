# Canonical Message

状态：Current

Canonical history 使用 Anthropic-compatible `user|assistant` message 与 text/thinking/redacted_thinking/tool_use/tool_result/image blocks。

Provider 调用前会删除 orphan result，并为缺失结果的 tool use 注入 unavailable stub。thinking signature 与 redacted data 可持久化以供后续模型请求，但 summary、日志、trace 和飞书展示永远不包含 encrypted data。

旧 `tool_call`、tool role 与 replacement/compaction JSONL 在 replay 时归一化，不要求数据迁移。
