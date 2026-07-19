# Context Assembly

状态：Current

## 目的

Context assembly 把持久化 history、本轮输入、system prompt 和当前 tool schemas 组装成一个可验证、可预算的 provider request。组装在每个 step 执行，而不是只在 turn 开始执行一次。

## Turn snapshot 与动态部分

Turn 开始固定：

- provider generation 与 context window。
- system prompt 文本。
- bot policy、connector filter 与初始 skill 列表。
- session/turn/route 和 trace scope。

Step 开始动态读取 `ToolExposureState.schemas()`。因此 `tool_search`、MCP exposure 和 skill activation 可以影响下一 step，但 provider model 或 system prompt 不会在 turn 中途变化。

## 输入顺序

1. `RuntimeStore.loadMessages()` replay 当前 model-visible history。
2. 当前 user content 作为 user message append 并立即持久化。
3. 每次 drain 的 steering 依次 append。
4. ContextPipeline 接收 cloned messages、system prompt 和本 step schemas。
5. prepare 返回可发送 messages 和 token/compaction 结果。

Runtime 在进入 ContextPipeline 前从自己的 Store pop pending events，并把它们放入当前用户内容；它们不经过 Router 或 `AgentJob.raw_data`。Context 本身不查询平台、Gateway queue 或 pending-event Store。

## Prepare 流程

`ContextPipeline.prepare()`：

1. 归一化 messages 与 blocks。
2. 修复 tool-use/tool-result closure。
3. 裁剪新进入 history 的 oversized tool result。
4. 估算 system、messages、tools 和 image。
5. 判断 soft threshold 与 hard limit。
6. 必要时选择跨 turn 或 mid-turn compaction plan。
7. 调用 provider summary，验证 token 确实降低。
8. 成功时追加最小 `context_patch` 并返回新 view。

`trigger="pre_call"` 只在预算超过 threshold 时摘要。`trigger="overflow"` 表示 provider 已明确拒绝请求，会强制尝试一次安全 compaction。

## Token 估算

文本按 UTF-8 bytes 近似为 `ceil(bytes/4)`。Object/tool schema 先稳定序列化再估算。Image 使用固定 1600 token 估值。完整 estimate 是：

```text
estimate(system)
+ estimate(messages)
+ estimate(tool schemas)
+ image estimates
```

Hard limit 为 `contextWindowTokens - reserveTokens`。默认 256k window、20k reserve；provider descriptor 可覆盖 window。

## Tool schemas

Exposure state 只返回当前可调用 definition：

- direct native tools 默认可见。
- deferred tools 必须被 `tool_search` 暴露。
- owner skill tools 必须先激活允许的 skill。
- disabled connector/MCP tools 不进入 schemas。

Budget 与实际 provider request 使用同一个 schema snapshot，防止预算漂移。

## Provider adaptation 边界

Canonical assembly 不为具体 provider 删除 thinking、image 或 signature。`RuntimeProvider` 在发送前克隆并适配 payload，例如 DeepSeek 删除不支持的 block。Storage 和下一 turn history 仍保持 canonical 数据。

## Failure 语义

- 无可摘要前缀：返回未压缩结果；若超过 hard limit，Runtime 显式 overflow。
- summary exception/empty：最多两次，失败后保留原 history。
- summary token 未下降：不写 `context_patch`，并返回 failure reason。
- abort：立即终止 summary/provider，不写半完成 checkpoint。
- post-turn maintenance 失败：warning，不影响已经完成的 reply。

## 验收

测试必须覆盖 tools 占用预算、image estimate、跨 turn/mid-turn selection、overflow trigger、steering 后重新组装和 summary failure preservation。
