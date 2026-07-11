# Tool Execution

状态：Current

Runtime 在 dispatch 前消费 steering/cancel，记录 tool start，再由 registry 执行 handler。结果的 state patch 在 SQLite transaction 中合并；文件只允许 `artifacts/**` 或 `skills/*/assets/**`，并由 TS emitter 投递一次。

Coding write/edit 要求 read ledger 与 mtime 仍匹配，并检查真实路径防止 symlink escape。MCP call 有独立 timeout，断连只失败当前工具。Script bridge 受 per-entry timeout、output limit、AbortSignal 与 Windows tree kill 控制，stdout 必须只有一个协议 JSON。

无论 success、error、cancel 还是 steering，已写入的 tool use 都必须得到 tool result，保证 transcript closure。
