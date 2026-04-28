下面是在**不修改原文内容**的前提下，为你整理添加的 **Markdown 格式结构版**（仅做排版与结构增强 👇）：

---

# 设计思路（MD整理版）

## 💡 核心设想

我设想有一种功能，比如一项任务耗时比较久，用户要求agent运行时，直接运行这个任务然后结束turn，任务在某一个时间点完成时提醒agent，agent提醒用户。

---

## ❓ 问题：如何实现？

那么，如何实现呢？
以 user 身份插入上下文？是的？准确说法是：event 文本拼在 user message 的 content 字符串前面，不是插入一条独立的 user message。 messages 数组里没有多出一条消息，只是某条 user message 的文本变长了。

还要准备一些必要数据作为该后台任务的标签，对吧？
用户id，会话id，平台。或者说还有 session id
有这三个应该就可以找到任务是在哪发布的了。

---

## ⚠️ 关键问题

问题是，定时到了，任务完成，进入处理队列，AI 轻松找到对应的会话和用户，但是 AI 怎么知道，这个完成的任务对应的请哪个请求？

---

## 🧠 上下文管理方案

上下文怎么管理呢？
任务完成后返回的文本伪造成 role 为 user 的 message 插入 messages。
"伪造"这个词不太准确。更准确的描述是：

场景 A：拼到用户真实消息的前面，不是伪造
场景 B（heartbeat）：系统构建一个完整的 agent turn，role 确实是 user，但这不是"伪造"——它就是系统发起的 turn，跟用户发起的 turn 走同一套流程

System: 前缀防伪机制：

用户消息如果包含 System: 会被改写为 System (untrusted):

这保证 AI 能区分真系统通知和用户伪造的文本。如果你要实现这套机制，这个安全细节值得加进去。

---

## 🔀 两种处理方式

### 场景 A：用户主动说话时，恰好有待处理的 event

用户发消息：

```
"查一下 PR"
```

处理流程：

```
用户发消息 "查一下 PR"
     │
     ▼ 构建 user message 时，drain 队列
```

构建后的 message：

```json
{
  "role": "user",
  "content": "System: [14:32:17] Background process completed...\n\n查一下 PR"
}
```

👉 说明：

* event 搭了用户消息的便车
* 这是最常见的消耗 event 的方式

---

### 场景 B：没有用户说话，heartbeat 主动唤醒

这才是你说的情况。此时没有用户原文，prompt 是 heartbeat runner 自己构建的：

```ts
// heartbeat-runner.ts 第 633-641 行
const { prompt } = resolveHeartbeatRunPrompt({
  cfg, heartbeat, preflight, canRelayToUser, workspaceDir,
});
const ctx = {
  Body: prompt,   // ← 系统构建的文本，不是用户说的
  From: sender,
  Provider: hasExecCompletion ? "exec-event" : "heartbeat",
};
```

构造出的 message：

```json
{
  "role": "user",
  "content": "System: [14:32:17] Background process completed (session s1a2b, exit code 0).\n\n[heartbeat 指令文本]"
}
```

👉 特点：

* 没有用户原文
* 整个 content 都是系统生成的

- Event 的格式规范
有明确的格式模式：
```js
// exec 完成通知（bash-tools.exec-runtime.ts）
enqueueSystemEvent(
  `Background process completed (session ${sessionId}, exit code ${exitCode}).\nLast output:\n${last400chars}`,
  { sessionKey }
);
```

heartbeat run 与 chat run 互斥
heartbeat 触发 agent turn 时会检查主队列是否空闲：

const queueSize = getQueueSize(CommandLane.Main);
if (queueSize > 0) {
  return { status: "skipped", reason: "requests-in-flight" };
}

这是关键设计——heartbeat 不会打断正在进行的 chat run，会退让等待。

---

## 🧾 总结

| 场景                | user message 的 content  |
| ----------------- | ----------------------- |
| 用户说话 + 有 event    | event文本 + `\n\n` + 用户原文 |
| 用户说话 + 无 event    | 用户原文                    |
| heartbeat 唤醒（无用户） | event文本 + `\n\n` + 系统指令 |

---

## ❓ 延伸问题

话说，已什么标准判断，哪个任务是 heartbeat?

exec 工具启动进程时，如果进程被 yield 到后台（没有在 yieldMs 内完成），就自动设置 notifyOnExit = true。之后进程退出时，回调里检查这个标志：

// bash-tools.exec-runtime.ts
function maybeNotifyOnExit(session) {
  if (!session.notifyOnExit) return;      // 不是后台任务，不通知
  if (session.notified) return;           // 已通知过，不重复
  if (!session.exited) return;            // 还没退出，不通知
  session.notified = true;
  // ... 构建 summary，enqueue + heartbeat
}

标准就是：任何被交给后台运行的进程，退出时都触发 heartbeat。

exec("npm test")
  │
  ├─ 启动进程
  ├─ 同时启动 yield 计时器（默认 10 秒）
  │
  ├─ 场景 A：进程在 10s 内完成 ✅
  │   → 清除计时器，直接返回完整结果（exit code + output）
  │   → 进程从未进入后台
  │
  └─ 场景 B：进程 10s 还没完成 ⏱️
      → 计时器触发 → markBackgrounded(session)
      → 立即返回 { status: "running", sessionId: "s1a2b3c" }
      → 进程继续跑，AI 可以用 process 工具查看
      → 进程结束时 → maybeNotifyOnExit() → system event + heartbeat

三种触发 yield 的方式
// 1. 模型显式请求后台运行 → 立即 yield（0ms）
exec({ command: "npm run build", background: true })
// yieldWindow = 0，启动即放后台

// 2. 模型指定等待时间
exec({ command: "npm test", yieldMs: 5000 })
// 等 5 秒，没完成就放后台

// 3. 默认行为（最常见）
exec({ command: "npm test" })
// 等 defaultBackgroundMs（默认 10000ms），没完成就放后台

默认值和范围
// bash-tools.exec.ts 第 154-159 行
const defaultBackgroundMs = clampWithDefault(
  defaults?.backgroundMs ?? parseIntEnv("PI_BASH_YIELD_MS"),
  10_000,    // 默认 10 秒
  10,        // 最小 10ms
  120_000,   // 最大 120 秒
);

yield 后进程不会被杀掉
const onAbortSignal = () => {
  if (yielded || run.session.backgrounded) {
    return;  // 已经在后台了，abort 不杀它
  }
  run.kill();  // 还在前台才杀
};

还有一个关键细节——后台进程自动取消超时：

const backgroundTimeoutBypass =
  allowBackground && explicitTimeoutSec === null && (backgroundRequested || yieldRequested);
const effectiveTimeout = backgroundTimeoutBypass ? null : (explicitTimeoutSec ?? defaultTimeoutSec);

如果进程被 yield 到后台且没有显式设置 timeout，默认的 30 分钟超时会被取消，让后台任务可以无限运行。

---

## 🛠️ 当前策略

先只用 exec 来做这个 heartbeat wake 系统

---

## ⚙️ 执行流程（Exec 完成 → 触发唤醒）

```ts
// bash-tools.exec-runtime.ts
enqueueSystemEvent(summary, { sessionKey });
requestHeartbeatNow({ reason: "exec-event", sessionKey });
```


---


1. 用户怎么知道任务进了后台？
AI 的 exec tool result 会告诉它，AI 再告诉用户。

当进程 yield 到后台时，exec 返回给 AI 的结果是：

Command still running (session abc123de, pid 12345).
Use process (list/poll/log/write/kill/clear/remove) for follow-up.

status: "running"
sessionId: "abc123de"
tail: "npm test\n  running 42 tests..."   ← 已经产生的输出

AI 看到 status: "running" 就知道这个命令没跑完，进了后台。然后它会自然语言告诉用户，比如：

"npm test 还在跑，我先放后台了（session abc123de）。完成后会通知你。"

用户不直接跟后台系统交互，AI 是中间人。

2. 想明确某个任务进入后台？
AI 可以用 process 工具查看所有后台进程：

process action=list

返回所有存活的 session 列表。或者对特定 session 轮询：

process action=poll sessionId="abc123de"

查看它的最新输出和状态。

3. 用户想取消后台任务？
用户说 "取消那个测试"，AI 调用：

process action=kill sessionId="abc123de"

执行流程：

AI 调用 process(action=kill, sessionId=abc123de)
  │
  ├─ 1. 先尝试 supervisor.cancel() 优雅终止
  │
  ├─ 2. 失败则 killProcessTree(pid) 强制杀进程树
  │
  ├─ 3. 标记 session 为 exited + SIGKILL
  │
  └─ 返回 "Killed session abc123de"

完整生命周期
用户: "跑一下测试"
  │
  ▼
AI 调用 exec("npm test")
  │
  ├─ 10s 内完成 → 直接返回结果 → AI 告诉用户 → 结束
  │
  └─ 10s 没完成 → yield 到后台
       │
       ▼
  tool result: { status: "running", sessionId: "abc123de" }
       │
       ▼
  AI 回复用户: "测试还在跑，放后台了"
       │
       ├─ 用户: "看看跑到哪了" → AI 调用 process(action=poll)
       ├─ 用户: "取消吧"      → AI 调用 process(action=kill)
       └─ 进程自己跑完        → system event → heartbeat 唤醒
                                → AI: "测试跑完了，全部通过"

整个过程中用户只跟 AI 对话，AI 通过 exec/process 两个工具管理进程。 用户不需要知道 sessionId、不需要知道 heartbeat 机制存在——这些都是 AI 和基础设施之间的事。

---

