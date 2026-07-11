# Turn Execution

状态：Current

事实来源：[`packages/runtime/src/runtime.ts`](/packages/runtime/src/runtime.ts)。

## Turn snapshot

每个 turn 开始时固定一次 provider snapshot、system/skill prompt 和 tool exposure state。Dashboard 的模型、thinking、connector 或 MCP 变化从下一 turn 生效，不会改变正在执行的 turn。

## Step loop

每个 LLM step 前按顺序执行：

1. 检查 cancel，并消费 steering。
2. 运行 token-aware `ContextPipeline`，验证 canonical tool closure。
3. 读取本 turn 当前已暴露的 tool schemas。
4. 调用 provider；timeout、429、连接错误和 5xx 最多三次，鉴权/参数错误立即失败。
5. context overflow 不走普通重试：强制压缩后只重试一次。
6. 持久化 assistant tool-use，再逐个 dispatch 工具并即时写入 tool result。

原生 direct 工具立即可见；MCP 与业务 script tools 默认 deferred。`tool_search` 命中后从下一 step 暴露；读取某个 `SKILL.md` 会激活 owner tools 并记录 skill usage。

## Cancel 与 steering

LLM、summary、MCP 和 script/process 工具共用 turn `AbortSignal`。取消发生在多个 tool use 之间时，尚未 dispatch 的调用会写入 cancelled result stub，保证 transcript 闭合。steering 在 LLM step、tool dispatch 与 context checkpoint 前消费；必要时跳过剩余工具并让 provider 重新判断。

## 最大步骤

默认最多 50 step。达到上限会持久化当前闭合状态，并回复“本轮已达到最大步骤，请发送下一条消息继续”，不当作内部错误。

## 最终回复

飞书 turn 使用一个 `FinalAnswerStreamer` 和单一 `emit_id`：thinking、tool 状态、正文与终态关闭同一张 CardKit 卡。只有从未成功投递任何流帧时才回退一次普通 final/error；cancel 不创建新错误卡。

## Usage 与 trace

turn、provider attempt、tool、skill、retry、cancel 与 context checkpoint 写结构化日志和 usage tables。`AGENT_STREAM_*` 与 `AGENT_SSE_WIRE_TRACE_*` trace 使用日期/session/turn/step/attempt 层级，并与 runtime log 共用脱敏和保留策略。
