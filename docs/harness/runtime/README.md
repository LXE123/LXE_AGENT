# Runtime 文档入口

状态：Current

## 目的

这个目录解释当前 `agent_runtime/` 如何执行一次 agent turn。读者如果想理解 `AgentJob` 进入 runtime 后如何加载 skill、组装上下文、调用 LLM、执行工具、写回状态并发出最终回复，应该先从这里进入。

## 设计理念

Runtime 文档按执行边界组织，而不是按早期设计概念组织。Gateway 负责平台接入和调度，runtime 负责单个 turn 的执行机制；skill catalog 负责说明可用能力，runtime 只解释这些 skill 如何进入本轮上下文。这样 gateway、runtime、skill 三个层次不会互相覆盖。

## 链路位置

Runtime 位于 `SessionScheduler -> TurnHandler -> run_turn -> AgentLoop -> TurnOutcome -> persist/final emit` 这一段。它从 gateway scheduler 接收已授权、已绑定 session 的 job，然后把执行结果交回 gateway emitter 或 session storage。

旧的 runtime 设计稿已经删除；当前事实以本目录的 `Current` 文档和对应代码为准。

## 当前入口

- [Runtime Flow](runtime_flow.md)：端到端运行链路，从平台入站到 runtime 执行再到平台出站。
- [Turn Execution](turn_execution.md)：runtime 内部核心执行链路，覆盖 `TurnHandler`、`run_turn()`、`AgentLoop.run()`、`TurnOutcome`、持久化和 final emit。
- [Runtime Context](context/README.md)：context state、canonical messages、context assembly 和上下文裁剪/压缩。
- [Runtime Tools](tools/README.md)：runtime tool schema 入口；后续 tool execution 文档也放在这里。

## Runtime 范围

本目录描述 `agent_runtime/` 的运行机制：

- turn handler 如何接住 `AgentJob`。
- runtime entry 如何加载 visible skills 和 tool registry。
- agent loop 如何执行 LLM/tool step。
- context 子系统如何决定本轮 LLM 看到的输入。
- tools 子系统如何把工具 schema 暴露给模型。
- outcome 如何写回 session，并经 emit bus 发回 gateway。

LLM provider integration 见 [LLM Integration](../llm/README.md)；runtime 只通过 `agent_runtime/llm_adapter.py` 调用它。Gateway 生命周期、平台 adapter、session routing、scheduler 和 heartbeat wake 见 [Gateway 文档入口](../gateway/README.md)。运行时 skill 列表和旧 skill 归档见 [Skill docs](../skill/README.md)。
