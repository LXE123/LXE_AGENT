exec 用来做什么的，目的是什么？
- exec 是 shell 命令执行器。
- shell 命令就是终端输入的命令。
- 通过 exec 启动的任何东西都是进程。
- exec 启动的进程会进入两种 map，这两种 map，一种是存放运行中的进程，一种是存放已完成的进程

// execSchema 的参数
command   // 任意 shell 命令
workdir   // 工作目录
env       // 注入环境变量
yieldMs   // 等 N 毫秒后自动转后台（默认 10000ms = 10秒）
background // 立刻转后台，不等
timeout   // N秒后强制杀死进程

exec 的工具介绍：
Execute shell commands with background continuation for work that starts now.
Use yieldMs/background to continue later via process tool.
For long-running work started now, rely on automatic completion wake when it is enabled
and the command emits output or fails; otherwise use process to confirm completion.
Use process whenever you need logs, status, input, or intervention.
Do not use exec sleep or delay loops for reminders or deferred follow-ups; use cron instead.

---

process 只用来查询 exec 进程的对吗，查询 exec 进程就是 process 的唯一目的？
- process 的 list 只会列出 exec 启动的进程会进入的两种 map
- process 是完整的进程调用工具，分两类操作：

读取类（查询）：

action	作用
list	列出所有运行中和已完成的进程
poll	取新增输出（增量 drain）+ 状态
log	读完整历史日志，支持分页（幂等）

操作类（干预）：

action	作用
write	向进程 stdin 写入数据
send-keys	发送按键序列（比如 Ctrl+C、方向键）
submit	发送回车（CR）
paste	粘贴文本（支持 bracketed paste 模式）
kill	终止进程
clear	从 registry 删除已完成的进程记录
remove	杀死并删除（运行中也能删）

process 的工具介绍：
Manage running exec sessions for commands already started: list, poll, log, write, send-keys, submit, paste, kill.
Use poll/log when you need status, logs, quiet-success confirmation, or completion confirmation
when automatic completion wake is unavailable.
Use write/send-keys/submit/paste/kill for input or intervention.
Do not use process polling to emulate timers or reminders

---

我目前的问题是什么？
- AI 喜欢乱调用工具，特别是乱用 process，疯狂查询
- 还有一个偏离主题的，AI 也很喜欢毫无理由的调用飞书工具

我目前的目的是什么？
- 运行超过 10s 的 exec 进程，就不该一直查询了，放心让它进入后台才对。


---

目前 exec 遇到了一个问题