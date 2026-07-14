exec 用来做什么的，目的是什么？
- exec 是 shell 命令执行器。
- Windows 使用 PowerShell；macOS/Linux 使用 `/bin/sh -c`，不会加载用户 shell profile。
- Python、pip 和 lxeskill 固定使用项目 `.venv`，不依赖启动 Gateway 时的用户 PATH。
- Gateway 会向 exec 子进程注入 `LXESKILL_SKILL_SCOPE`（当前 bot 可见的 skill 名单，与系统提示层可见性同源）。lxeskill 据此在 list/describe/执行时隐藏或拒绝（`skill_not_in_scope`）越界业务命令；maintenance 类基础设施命令（如 `auth refresh`）不受 scope 限制，保证认证失败的自愈提示对所有 bot 有效。外部宿主没有这个变量时 CLI 不设限。
- shell 命令就是终端输入的命令。
- 通过 exec 启动的任何东西都是进程。
- exec 启动的进程会进入两种 map，这两种 map，一种是存放运行中的进程，一种是存放已完成的进程

// execSchema 的参数
command   // 任意 shell 命令
cwd       // 工作目录
yield_ms  // 等 N 毫秒后自动转后台（默认 10000ms = 10秒）
background // 立刻转后台，不等
timeout   // 前台超时秒数，默认 120，允许 1-3600；background=true 时不启用计时器

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

