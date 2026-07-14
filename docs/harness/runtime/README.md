# TypeScript Runtime

状态：Current

## 目的

Runtime 负责单个 turn 内的模型调用、上下文预算、工具执行、streaming、持久化和 usage。它由 Gateway 在同一 Bun 进程内直接调用，不解析平台事件，也不持有平台 SDK。

## 当前边界

[`packages/agent/runtime/src`](/packages/agent/runtime/src) 包含生产 Runtime：

- `runtime.ts`：turn 与 step 状态机。
- `context.ts`：canonical message、token 估算、裁剪、修复和摘要压缩。
- `provider.ts`：provider catalog、streaming、retry 和热切换。
- `registry.ts`、`coding-tools.ts`、`lxeskill-command.ts`、`mcp.ts`：工具注册、命令边界与执行。
- `skills.ts`：skill discovery、过滤与 prompt。
- `storage.ts`：SQLite、JSONL transcript 和 usage。
- `final-answer-streamer.ts`：统一 final stream 状态。
- `trace.ts`：turn/provider/tool trace 与脱敏。

生产进程没有 worker fallback。浏览器、ERP 和表格业务代码只能通过 native `exec` 调用 catalog 注册的独立 `lxeskill ...` 命令；它们不是 Runtime service，skill 也不能直接调用内部 Python module 绕过 CLI。

## 专题导航

- [Runtime Flow](runtime_flow.md)：从 Gateway ingress 到最终平台发送的端到端边界。
- [Turn Execution](turn_execution.md)：turn snapshot、step loop、provider、tool 和 final outcome。
- [Turn Step Lifecycle](turn_step_lifecycle.md)：单 step 的固定顺序与闭合条件。
- [Context](context/README.md)：canonical history、组装、持久化和 compaction。
- [Tools](tools/README.md)：native、deferred、MCP、skill-owned 与 `lxeskill` command boundary。

## 生命周期

Runtime start 先启动 store，再按顺序启动 process manager、MCP manager、maintenance 等 services；任一 service 启动失败会逆序停止已启动服务并关闭 store。stop 逆序停止 services，再关闭 store。

每个 active turn 由 Gateway 的 `RunHandle` 提供共享 `AbortSignal`。Runtime stop 不创建新的 turn，也不静默重放 active work；Gateway 负责在停止前 abort 并等待 active outcome。

## 核心不变量

1. turn 开始时固定 provider、system prompt 和初始 exposure 条件。
2. 每个 step 在 provider request 前完成 canonical closure 与 context budget 检查。
3. assistant tool use 先持久化，tool result 逐个执行并即时持久化。
4. cancel/steering 发生在工具中间时仍写闭合 result stub。
5. summary 失败不能静默删除原始历史。
6. artifact 发送失败不能重跑已完成业务工具。
7. transcript、usage 和 trace 的写入不泄露 secret 或 encrypted thinking data。

## 文档事实原则

Current 文档描述实际 TypeScript 源码和测试，不作为未来架构提案。默认值、错误分类或步骤顺序变化时，必须同时更新相关测试和本目录文档。
