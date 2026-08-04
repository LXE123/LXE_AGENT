# Session Scheduler and Cancellation

状态：Current

## 目的

`SessionScheduler` 把来自用户、heartbeat 和控制面的 job 转换成有序 turn。它保证同 session 串行、跨 session 有界并发，并把 cancel、steering 和 Runtime completion 聚合到一个 `RunHandle`。

事实来源是 [`apps/gateway/src/orchestration/scheduler.ts`](/apps/gateway/src/orchestration/scheduler.ts) 及其测试。

## 数据结构

Scheduler 维护四类状态：

- `pending`：每个 session 的 FIFO job 队列。
- `ready` / `readySet`：可被 dispatch 的 session，避免重复入队。
- `activeBySession`：保证一个 session 最多一个 active run。
- `activeByRun`：按 run id 校验 Runtime completion 与控制操作。

全局 active session 数不得超过 2。该限制由 Gateway composition 固定传入 Scheduler，不再由环境变量配置。

## Enqueue 与 dispatch

普通 job 进入 session queue 后，只有 Runtime ready 且该 session 不 active 时才进入 ready queue。`drain()` 在全局并发额度内逐个创建 `RunHandle` 并调用进程内 Runtime port。

`startTurn()` 返回只表示 Runtime 接受了启动，不代表 turn 已完成。active slot 只能由匹配的 `runtime.turn.completed` 释放。这样即使 start acknowledgement 与 completion 并发到达，也不会提前运行同 session 的下一条消息。

Runtime unhealthy 时 scheduler 保留 queued job，不继续 dispatch。start 被拒绝的 handle 仍保持 active，直到 Runtime 明确 terminalize，避免同一 session 同时运行两次。

## RunHandle

每个 handle 固定保存：

- `runId`、`sessionId`、`jobId` 与原始 `AgentJob`。
- 一个共享 `AbortController`。
- steering queue 与已接受 cancel 状态。
- start failure 和 closing/terminal 状态。

Provider、summary、MCP 和 exec/wait 的当前观察都接收同一个 abort signal。exec 进程创建成功后立即归 Session manager，不登记到 RunHandle；取消 turn 只停止观察，进程继续运行。显式 terminate、Session 删除或 Runtime 关闭仍使用完整进程树语义。

## Completion 校验

Scheduler 只接受 run id、session id 和 job id 与 active handle 完全一致的 completion。以下情况视为一致性错误：

- unknown run completion。
- session/job mismatch。
- 非法 completion status。
- scheduler 已拒绝但 Runtime 仍报告不兼容终态。

显式 terminalize 后到达的晚 completion 可以忽略。正常 completion 会释放 active maps、处理剩余 steering，并让该 session 的下一条 queued job 重新 ready。

## Cancel 与 `/stop`

`cancel()` 只作用于当前匹配 handle，并具有幂等语义：

1. 清理该 session 尚未开始的 pending jobs。
2. 标记 cancel requested。
3. abort 当前 handle。
4. 等待 Runtime 写入闭合 transcript 并报告 cancelled/error completion。

重复或并发 stop 会合并到同一个 cancel 操作。`run_not_found`、`run_closing` 等预期边界不会伪装成成功接受新的 cancel；意外错误会向调用方传播，但不能污染 handle 状态。

取消发生在多个 tool use 中间时，Runtime 会为尚未 dispatch 的 tool 写 cancelled result stub，使 provider history 和 transcript 保持 tool-use closure。

## Steering

纯文本 steering 只注入 active run。Runtime 在这些安全边界消费：

- 新 LLM step 前。
- tool dispatch 前。
- context checkpoint/compaction 前。

未被消费且 run 非 cancelled 时，scheduler 将 steering 合并成新 `AgentJob` 放回队首，并使用最后一条 steering 的 response route。被取消的 run 丢弃剩余 steering，避免用户停止后自动继续。

如果 steering 到达时 run 已 closing 或不存在，Router 会把它作为普通消息排队。

## Heartbeat job

`HeartbeatWakeQueue` 按 session 合并 wake request。exec 完成不再进入该队列；其它 wake 处理时依次检查：

1. session autonomy 未 suspended。
2. SQLite 中仍有 pending event。
3. session 当前没有 inflight work。
4. session source 仍能构造有效 key。

忙碌 session 被重新标记为 retry；无事件、无 session 或 source 无效的 wake 被丢弃。最终 heartbeat 仍生成标准 `AgentJob` 并经过同一 scheduler。

## 停止与健康状态

Gateway stop 先让 scheduler 拒绝新 job，再取消 active run 并等待 Runtime 停止。Runtime readiness 变化会暂停或恢复 drain。health 需要同时反映 queued、active、runtime ready 与 channel 状态，不能只根据进程存活判断可用性。

## 不变量

- 同 session 永远不并发。
- completion 是释放 active slot 的唯一正常入口。
- cancel 不绕过 transcript closure。
- steering 不允许丢失或跨 session。
- heartbeat 不绕过 permission/session/scheduler 路径。
