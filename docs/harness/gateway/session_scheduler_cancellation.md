# Session Scheduler And Cancellation

状态：Current

## 目的

这篇文档解释 gateway 如何把多个 session 的 agent job 安排到有限并发里执行，并在用户停止或进程关闭时传递取消信号。读者如果在排查同一会话排队、跨会话并发、`/stop`、tool 取消或 gateway shutdown，应该读这一篇。

## 设计理念

调度层只关心执行秩序和取消传播，不关心消息来自哪个平台、用户是否有权限、LLM 如何生成答案。它用“同 session 串行、跨 session 有上限并发”的规则保护会话历史顺序，同时用 `RunHandle` 把取消信号传给 provider 和 tool。

## 链路位置

这一层位于 `SessionRouter` 和 `TurnHandler` 之间。`SessionRouter` enqueue `AgentJob`，`SessionScheduler` 决定何时启动，启动后调用 `GatewayApp._execute_agent_job()`，再进入 `handle_unified_turn_job()` 和 `AgentLoop`。

本文维护 gateway 的 session 调度和取消模型。事实来源是 [gateway/session_scheduler.py](../../../gateway/session_scheduler.py)、[gateway/session_router.py](../../../gateway/session_router.py) 和 [agent_runtime/turn_handler.py](../../../agent_runtime/turn_handler.py)。

## 调度目标

`SessionScheduler` 解决两个约束：

- 同一个 `session_id` 内的 job 必须串行执行。
- 不同 session 可以并发执行，但总并发受 `AGENT_MAX_CONCURRENCY` 限制。

它不理解平台消息、权限或 LLM 细节，只接收 `AgentJob` 并调用构造时传入的 `executor(job, run_handle)`。

当前 executor 是 `GatewayApp._execute_agent_job()`，它调用 `handle_unified_turn_job()`，并注入 `GatewayEmitter` 的 final、stream 和 typing 回调。

## 队列结构

`SessionScheduler` 内部维护：

- `_pending_by_session`：每个 session 的 pending job 队列。
- `_ready_sessions`：可启动 job 的 session 队列。
- `_ready_set`：避免同一 session 重复进入 ready queue。
- `_active_runs`：正在执行的 `session_id -> RunHandle`。
- `_running_tasks`：所有 asyncio task。
- `_task_sessions`：task 到 session_id 的反向映射。

`enqueue(job, front=False)` 会把 job 放入对应 session 队列，标记 session ready，然后调用 `_drain()`。

## 串行和并发规则

`_drain()` 当前规则：

- 如果 scheduler 正在 stopping，直接返回。
- 只要 running task 数量小于 `_max_concurrency`，并且有 ready session，就继续启动。
- 如果 session 已经 active，则跳过，保证同 session 串行。
- 每次从某个 session 取一个 job 启动。
- job 启动后创建 `RunHandle` 和 asyncio task。
- task done 后移除 active run，再把该 session 重新标记 ready。

因此，同一个 session 的第二个 job 一定等第一个 job 完成后才会启动；其它 session 可以并行，直到达到全局并发上限。

## RunHandle

`RunHandle` 是 gateway 到 agent runtime 的取消桥：

- `cancel_event`：asyncio cancel signal。
- `thread_cancel_event`：线程或 blocking tool 可用的 cancel signal。
- `set_provider_cancel_handle()` / `clear_provider_cancel_handle()`：注册 LLM provider 的取消回调。
- `register_tool_run()` / `finish_tool_run()`：跟踪 tool call 和 tool cancel handle。
- `request_cancel()`：同时设置两个 cancel event，并调用 provider 和 tool cancel handle。

如果 provider 或 tool 在取消已经发生后才注册 cancel handle，`RunHandle` 会在注册时立刻调用该 handle。

## /stop 取消链路

`SessionRouter` 收到 `/stop` 后：

1. 根据 `session_key` 找到绑定 session。
2. 调用 `SessionScheduler.request_stop(session_id)`。
3. 如果 active run 存在，`RunHandle.request_cancel()` 被触发。
4. provider 和正在运行的 tool 尽量收到取消信号。
5. router 发送控制反馈。

`request_stop()` 只取消 active run，不会删除 pending queue。

## /clear 和 inflight 判断

`/clear` 创建新 session 前会调用 `SessionScheduler.has_inflight_work(session_id)`：

- active run 存在时返回 true。
- pending queue 里还有 job 时返回 true。

如果存在 inflight work，router 拒绝 clear，避免同一个来源在旧 job 未完成时被旋转到新 session。

## stop()

`SessionScheduler.stop()` 用于 gateway 关闭：

- 标记 `_stopping=True`。
- cancel 所有 running tasks。
- 等待 task gather，受 timeout 限制。
- 清空 pending、ready、active、task 映射。
- 对残留 active handles 标记 `cleanup_state="stopped"` 并调用 `request_cancel()`。

这是进程关闭语义，不等同于用户 `/stop`。
