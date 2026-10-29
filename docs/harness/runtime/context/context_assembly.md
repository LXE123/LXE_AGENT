# Context Assembly

上下文组装把持久化历史、本轮输入、system prompt 和当前工具定义组合为模型请求。它在每个 step 执行，不只在 turn 开始执行一次。

## 固定与动态部分

Turn 开始固定模型配置、system prompt、允许的 Skill 元数据和 session／turn／route 标识。每个 step 重新取得可见工具，并刷新环境和权限上下文；工具调用本身仍检查当前执行权限。

`tool_search`、MCP 工具暴露和 Skill 激活可以改变下一 step 的工具列表。预算估算与实际请求使用同一份 schemas。模型配置的生效时机见 [模型目录](../../llm/provider_catalog.md#选择与生效)，工作区指令快照见 [Workspace Instance](../workspace_instances.md)。

## 输入与组装顺序

1. Store 从 transcript 恢复当前模型视图。
2. Runtime 追加用户输入、附件、pending events 与入口诊断；明确指定的 Skill 按 [Skill 加载规则](../../skill/README.md#目录加载与激活)加入上下文。
3. 后续收到的 steering 按消费顺序追加为独立用户消息。
4. 每个 step 捕获工具定义，`ContextPipeline.prepare()` 归一化消息、修复工具调用闭合，计算完整预算。
5. 需要压缩时选择历史或当前 turn 的早期内容，调用摘要、校验结果并持久化 patch。
6. Runtime 检查压缩失败与硬上限；刷新环境时间，必要时追加环境消息，再发起模型请求。

新工具结果在执行循环收集后按文本预算裁剪，再组成 tool message；不是每次 `prepare()` 都重新裁剪全部历史。pending events 由 Runtime 自己的 Store 消费，ContextPipeline 不查询 Gateway 队列或平台。

## 预算与适配

预算覆盖 system prompt、消息、可见工具和图片，也为待加入的环境信息留出空间。文本与结构先做本地估算；有匹配的历史 usage 锚点时，采用实际输入量加后续变化量校准。公式、默认值和压缩触发条件见 [Pruning and Compaction](context_pruning_compaction.md)。

组装保留统一消息格式。Provider 在请求副本上处理特定协议的图片、思考和签名；摘要消息也在请求边界转换为用户上下文。协议适配不反向覆盖 transcript。

## 失败与验证入口

压缩失败、没有安全前缀或压缩后仍超过硬上限时，Runtime 明确结束本轮；摘要失败不写 compaction patch。原始记录保留。Turn 结束后的维护异常只记录 warning。

实现与对应测试：[执行循环](../../../../packages/agent/runtime/src/engine/runtime.ts)、[上下文组装与压缩](../../../../packages/agent/runtime/src/engine/context.ts)、[Context 测试](../../../../packages/agent/runtime/test/engine/context.test.ts)、[动态环境测试](../../../../packages/agent/runtime/test/engine/environment-context.test.ts)。按实际改动选择定向验证，策略改动遵循 PR 审查规范。
