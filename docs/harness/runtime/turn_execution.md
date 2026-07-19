# Turn Execution

状态：Current

## 目的

Turn 是 Runtime 的一次用户可观察执行单元。它从一个 `AgentJob` 开始，以 `TurnOutcome` 和闭合 transcript 结束。本文描述 snapshot、step retry、tool dispatch、cancel、final streaming 和 usage 记录。

事实来源是 [`packages/agent/runtime/src/engine/runtime.ts`](/packages/agent/runtime/src/engine/runtime.ts) 与对应测试。

## Turn snapshot

`runTurn()` 开始时读取 session，并固定：

- 当前 provider generation 与 descriptor。
- system prompt 和允许的 skill 集合。
- tool exposure 初始条件与 connector policy。
- model/context window 和 CardKit display 设置。
- session、response route、turn id 与 trace scope。

Dashboard 的模型/thinking、MCP、connector 或 skill 状态变化不会改写正在执行的 turn。provider 热切换从下一 turn 生效；turn 内 tool search/skill activation 只改变后续 step schemas。

## 初始化

飞书普通 turn best-effort 添加 typing reaction，并创建一个 `FinalAnswerStreamer`。每个 turn 开始时，Runtime 从自己的 Store pop pending events；普通 turn 把它们附加到当前 user content，heartbeat 则只处理这些事件。随后 Runtime load replay，并追加当前 user message。Router 和 `AgentJob.raw_data` 不承载 pending events。

Runtime 同时初始化 turn/tool/skill usage counters。usage 最多写一次，即使 final delivery 或 post-turn maintenance 抛错也不能重复计数。

## Step loop

默认 `maxSteps=50`。每个 step：

1. 检查 handle cancelled/aborted。
2. drain steering 并 append 为 user message。
3. 从 exposure state 获取 tool schemas。
4. 调用 `ContextPipeline.prepare(trigger="pre_call")`。
5. 发送 provider request并消费 stream events。
6. 持久化 canonical assistant content。
7. 无 tool use 时结束；有 tool use 时逐个 dispatch。

Context prepare 返回新的 message view、compaction usage、token estimate 和 failure flags。失败摘要或仍超过 hard limit 会显式终止，不使用本地伪摘要。

## Provider attempt

普通 step 最多三次 attempt：

- timeout、429、连接问题和 5xx 可重试。
- authentication、permission、invalid request 等非 retryable 错误立即失败。
- abort 不重试。
- context overflow 不消耗普通 retry budget。

发生 overflow 时，Runtime 用相同 messages/tools 强制执行一次 `prepare(trigger="overflow")`。只有确实完成安全压缩且回到 hard limit 内，才允许一次 provider retry；再次 overflow 直接失败。

每次 attempt 都记录 provider/model、step、attempt、usage 和错误分类，但不记录 secret 或 encrypted thinking data。

## Stream 处理

Provider event 被归一为 text delta、thinking delta 或 redacted thinking count，并交给 `FinalAnswerStreamer`。streamer 节流重复快照，维护单调 sequence 和同一 emit id，同时累计 input/output/cache/context metrics。

Provider 完成后，完整 assistant content 作为 canonical message 持久化。展示文本与持久化 history 分离：thinking signature 和 redacted block 可以留在 history，但平台和日志只能看到允许的文本或计数。

## Tool dispatch

Runtime 从 assistant content 中按顺序取得合法 `tool_use`：

- dispatch 前再次检查 steering 和 cancel。
- `ToolRegistry.execute()` 验证工具存在、当前已暴露并接收 object input。
- state patch 通过 store 的受控 merge 写入。
- artifact files 通过 emitter 的 tool action 立即发送。
- result/error 转成 `tool_result`，经单结果预算裁剪后 append transcript。

每个 tool call 更新 duration、error、owner skill usage 和 trace。工具异常不会跳过 result；错误文本以 `is_error=true` 返回模型，由下一 step 决定恢复或结束。

## Steering 与 cancel

如果 steering 在一组 tool use 中间到达，尚未执行的调用写 skipped stub，然后先 append tool results，再 append steering。模型下一 step 会看到闭合的原计划和新指令。

如果 cancel 到达，剩余调用写 cancelled stub，streamer 执行 cancel close，turn 记录 cancelled outcome。cancel 不创建新的普通错误卡。

## Final 与 post-turn

assistant 没有 tool use 时，text block 合并为 final reply。streamer 先完成同一张卡；只有此前从未成功发送 stream frame 时，Runtime 才尝试一次普通 final emit。

final 后执行 post-turn context maintenance。它可以追加 compaction `context_patch`，但失败只记录 warning，不撤销已交付答案。turn usage 和 trace 最终以 completed/cancelled/error 之一关闭。

## 最大步骤与错误回复

达到最大步骤时，Runtime 返回明确的“请发送下一条消息继续”提示，保留当前闭合状态。其它异常由错误路径关闭 streamer、best-effort final/error delivery、停止 typing 并记录 error outcome；错误处理本身不得让 Gateway 进程退出。
