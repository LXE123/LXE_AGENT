# Session Scheduler and Cancellation

状态：Current

事实来源：[`apps/gateway/src/scheduler.ts`](/apps/gateway/src/scheduler.ts)。

- 同 session 的 job 严格串行；不同 session 在 `AGENT_MAX_CONCURRENCY` 内并发。
- `RunHandle` 持有 `AbortSignal`、steering queue、cancel 状态和进程登记。
- cancel 会中断 provider、summary、MCP、script tool 与 coding process；Windows 子进程按树终止。
- steering 在 LLM step、tool dispatch 和 context checkpoint 前消费。
- stop 先拒绝新 job，清理 pending queue，再取消并等待 active run。

Scheduler 直接调用同进程 `AgentRuntime.runTurn()`，没有 worker client 或跨进程 envelope。
