中断对话时，怎么判断当前 session 是否是‘活’着的呢？

目前应用大概有两种方法：
1. 维护一个列表专门用来存放活动中的 session 的 id。（有一个好处是 列表 放在内存里，进程结束也跟着消失，不用担心维护正确的活跃状态问题）
2. 给 session 本身的字段加上一个 state，如果 state 为 active，那么说明 session 启动了

我的项目中是第二种，而且是比较糟糕的那种，我把这个 state 存到了 sqlite 数据库中，因为 sqlite 中是持久化保存，所以我还必须加上一个启动 agent 时把 session 调成 inactive 的逻辑。

---

我要改成第一种

好的，首先明确一些基础规则
1. session 只是上下文历史和元数据容器，不应该有是否运行的概念
2. 运行的是 agent loop，agent loop 使用了某个 session
3. 同一时刻，一个 session 最多对应一个 active agent loop。

---

具体怎么设计呢
在内存中维护一个 dict，存储有哪些 agent loop 正在运行。
dict 里面，key 是 session_id，value 是 RunHandle（存储着定义 agent_loop 的字段）

/stop 命令发送时，根据 session_id 找到 RunHandle，关停

activeRuns: Map<session_id, RunHandle>

RunHandle:
- run_id / job_id
- abort_controller
- 当前 provider stream 取消句柄
- 当前 tool/exec 进程句柄  // activeTools: Map<tool_call_id, ToolRunHandle>
- cleanup 状态
- started_at

---

关停的流程是什么？
设计流程首先要搞明白哪些是关停当前 loop 的难点
1. 关停时正好在接收供应商发送过来的 stream
目前项目中默认使用 kimi-code，然后发送请求和接收响应都是用的 anthropic SDK，那就先说这个走 anthropic api 路线怎么关闭。
使用 anthropic SDK 会创建一个 client（每次发送请求都会创建一个，不存在共享 client），那么我们要做的就是直接关闭这个 client。（通过当前 run 的 AbortController/AbortSignal 取消 provider stream）

然后这里有一个问题，一般来说是等待响应发送完后调用其中的 tool_call，那如果切断时 anthropic 正好发送了一个完整的 tool_call，会发生什么。

会把这个 tool_call 写进 message 中，然后主动补上补一条协议合法的 synthetic error tool result，类似比如：
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "isError": true,
  "content": "[The conversation was interrupted before this tool could finish.]"
}

2. tool 正在运行（特别是 exec 运行的命令）
- 首先，exec 执行的命令没进入后台任务的都要清理
- 被清理的 tool，如果没有 tool result 就补上协议合法的占位 result

3. 上下文还没有持久化
已经被 agent runtime 接收并形成完整 message/block 的内容，才可能持久化；
半截 stream delta、半截 tool args、未完成 JSON，不应该写入上下文；
一旦完整 tool_call 被写入上下文，就必须最终配上真实 tool_result 或 synthetic error tool_result。
