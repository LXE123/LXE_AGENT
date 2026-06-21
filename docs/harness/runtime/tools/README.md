# Runtime Tools 文档

状态：Current

## 目的

这个目录解释 agent runtime 里的工具系统。读者如果在排查工具为什么可见、工具 schema 如何给模型、tool call 如何进入执行器、工具结果为什么这样写回历史，应该从这里进入。

## 设计理念

Runtime tools 被拆成“工具定义和 schema”和“工具执行”两层。schema 文档说明内部 canonical schema 与 provider wire schema 的边界；execution 文档说明模型已经返回 tool call 后，runtime 如何查 registry、调用 handler、处理成功/失败/取消并写回 tool result。

## 链路位置

这一层位于 `AgentLoop` 和具体 tool handler 之间。`AgentLoop` 从 registry 取 active tool schemas 发给 LLM，模型返回 tool call 后，再通过 registry 找到 handler 并由 executor 带着 turn context 执行。

## 当前入口

- [Tool Schema](./tool_schema.md)：内部 canonical `ToolSchema`、registry 输出和 provider schema adaptation。
- [Tool Execution](./tool_execution.md)：`AgentLoop -> UnifiedToolRegistry -> ToolExecutionContext -> ToolResult -> tool_result message` 生命周期。
