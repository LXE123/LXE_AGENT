# Streaming Adapter

状态：Current

`RuntimeProvider.turn()` 将 SDK stream 归一为 `text_delta`、`thinking_delta` 和 `redacted_thinking`，最终返回 canonical assistant content、tool uses 与 usage。thinking signature 和 redacted block data 会进入 canonical history，但展示和日志只保留计数/占位。

每个 step 最多三次 attempt。`LLM_REQUEST_TIMEOUT_S`、429、连接错误和 5xx 可重试；认证和参数错误立即失败。context overflow 由 Runtime 强制压缩后只重试一次，不能消耗普通 retry budget。turn `AbortSignal` 同时中断当前请求、retry wait 和 summary。

结构化 attempt 日志由 Runtime 写入；[`packages/runtime/src/trace.ts`](/packages/runtime/src/trace.ts) 提供 agent/wire trace，并脱敏 token、authorization、cookie、绝对路径、base64 与 redacted thinking data。
