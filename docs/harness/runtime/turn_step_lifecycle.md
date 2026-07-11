# Turn Step Lifecycle

状态：Current

## 目的

Step 是一次 provider request 与其 tool dispatch 的闭合周期。固定 step 顺序能保证 cancellation、steering、context compaction 和 transcript replay 在任意中断点都得到同样结果。

## 固定顺序

```text
cancel checkpoint
  -> drain steering
  -> capture exposed tool schemas
  -> context prepare / repair / compaction
  -> provider attempts
  -> append assistant content
  -> no tools? final
  -> dispatch tool uses in order
  -> append closed tool results
  -> next step
```

Tool schemas 在 context prepare 前从当前 exposure state 取得，并用于同一次 token estimate 和 provider request，避免预算按一套 schema 估算、实际发送另一套。

## Step 前 checkpoint

Runtime 首先检查共享 abort signal。已取消 turn 不再调用 provider。随后 drain steering：每条非空文本作为独立 user message append，保持用户插话顺序。

ContextPipeline 执行：

- canonical block 归一化。
- tool-use/tool-result closure 修复。
- 已处理 image 占位。
- system、messages、tools、image 的完整预算估算。
- 90% soft threshold 与 hard limit 判断。
- 必要的 summary compaction。

prepare 失败不会修改持久化历史；成功 replacement 才写 checkpoint。

## Provider 阶段

Provider 使用 step 开始时固定的 system、messages、schemas 和 signal。stream event 可以持续更新同一张 final card，但只有完整 provider response 才会成为 assistant message。

普通 retry 保持 step number 不变，只增加 attempt。context overflow recovery 也保持同一 step，但重新构造压缩后的 messages，并且最多一次。

## Assistant 持久化

Provider response 无论包含正文、thinking 还是 tool use，都先作为 assistant message append。这样工具执行过程中进程退出，replay 仍知道哪些 tool use 尚待 result，sanitizer 可以补 unavailable stub。

没有 tool use 时，step 进入 final；正文为空也会以明确 outcome 结束，而不是无界继续请求模型。

## Tool 阶段

同一 assistant 中多个 tool use 按顺序执行。每个调用：

1. 检查 steering/cancel。
2. 验证 exposure 和 input schema 边界。
3. 记录 tool start 与展示状态。
4. 执行 native、MCP 或 script handler。
5. 应用 state patch、发送 artifacts。
6. 记录 duration、usage 与展示终态。
7. 构造 model-visible result。

全部结果组成 user message append。即使一个工具失败，后续工具仍按当前策略执行，除非 cancel 或 steering 明确中断计划。

## Exposure 生效时机

`tool_search` 本 step 可以命中并修改 exposure state，但新工具从下一 step 的 schema capture 才可调用。读取允许的 `SKILL.md` 激活 owner tools，同样从下一 step 生效。

这条规则避免 provider 在同一 response 中调用从未出现在 request schema 的工具。

## Steering 中断

tool dispatch 前发现 steering 时，当前及剩余未执行 tool use 都写 error result，说明用户在 dispatch 前改变计划。Runtime 先持久化这些 closure，再 append steering，并开始下一 step。

已完成工具不会重跑；已产生 artifact 不撤回。

## Cancel 中断

取消时剩余 tool use 写 cancelled stub。正在运行的 handler 通过 signal 终止；Runtime 等待必要的有界清理后关闭 streamer 和 turn usage。

cancelled step 不进入新的 provider request，剩余 steering 由 Scheduler 根据 run 状态决定丢弃或重新排队。

## Step 终止条件

Step 只以这些方式结束：

- 无 tool use，产生 final outcome。
- tool results 闭合，进入下一 step。
- cancel，产生 cancelled outcome。
- provider/context/Runtime 结构性错误，产生 error outcome。
- 达到 maxSteps，产生可继续提示。

任何单个 provider attempt、tool call 或 delivery 失败都不能使 Bun 进程退出。
