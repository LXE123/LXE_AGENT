# Agent CLI exec

## 先说结论

`agent-cli exec` 是面向脚本和 CI 的一次性 Runtime 入口。一次命令只执行一个 turn，完成后关闭 Runtime；Desktop 继续使用长驻的 `agent-cli serve`，两者的协议、数据库和生命周期互不混用。

源码环境可从仓库根运行：

```bash
bun apps/agent-cli/src/main.ts exec "总结当前仓库"
printf '%s\n' "检查这些日志" | bun apps/agent-cli/src/main.ts exec -
bun apps/agent-cli/src/main.ts exec --json -C ./packages "检查类型边界"
```

当前安装包不会把 `agent-cli` 加入系统 `PATH`。打包环境需要显式调用应用携带的可执行文件；系统命令安装和 GitHub Action 尚未提供。

## 命令与输入

```text
agent-cli exec [--json] [--ephemeral] [-C DIR] [-o FILE] [PROMPT|-]
agent-cli exec resume [SESSION_ID | --last] [--json] [-C DIR] [-o FILE] [PROMPT|-]
```

- 有 `PROMPT` 且 stdin 是终端时，直接使用参数。
- 没有参数或参数是 `-` 时，非空 stdin 是完整 Prompt。
- 同时提供参数和管道输入时，参数是指令，stdin 以 `<stdin>...</stdin>` 标记为附加上下文，避免两者悄悄拼成一句话。
- 空输入、未知参数和不合法组合返回退出码 `2`。
- `-C/--cd` 选择工作目录；`-o/--output-last-message` 只在成功得到最终回复后原子写文件，最终回复仍照常输出。

## 输出契约

普通模式只把最终回复写到 stdout。thread 标识、工具进度、初始化错误和 Runtime/Provider/工具的真实脱敏错误写到 stderr，因此调用方可以安全地把 stdout 用作下游输入。

`--json` 模式的 stdout 只包含 `ExecEventV1` JSONL；每一行都能独立解析，Runtime 自身的诊断日志仍可写到 stderr。事件带固定的 `version: 1`，可能的 `type` 是：

- `thread.started`
- `turn.started`
- `item.updated`
- `item.completed`
- `turn.completed`
- `turn.failed`
- 顶层 `error`

`item` 是公开的 `agent_message`、`tool`、`file` 或 `progress` 结构，不复用 Desktop 的 request/response envelope，也不直接暴露内部 `EmitRequest`。成功的终止事件包含非负整数 usage；失败事件保留经过统一 secret 脱敏和显式长度限制的实际错误。

示例：

```json
{"version":1,"type":"thread.started","thread_id":"01234567-89ab-4cde-8fab-0123456789ab"}
{"version":1,"type":"turn.started","thread_id":"01234567-89ab-4cde-8fab-0123456789ab","turn_id":"turn-id"}
{"version":1,"type":"item.completed","thread_id":"01234567-89ab-4cde-8fab-0123456789ab","turn_id":"turn-id","item":{"id":"turn-id:final","type":"agent_message","text":"完成","status":"completed","sequence":0}}
{"version":1,"type":"turn.completed","thread_id":"01234567-89ab-4cde-8fab-0123456789ab","turn_id":"turn-id","usage":{"input_tokens":10,"output_tokens":2,"tool_calls":0}}
```

退出码固定为：成功 `0`，Runtime/Provider/工具/初始化或存储失败 `1`，参数或输入错误 `2`，收到 SIGINT/SIGTERM 并取消当前工具进程后 `130`。

## 会话与存储

新建持久化 thread 使用 UUID，数据位于：

```text
<data-root>/db/exec-sessions/<thread-id>/agent.sqlite3
<data-root>/db/exec-sessions/<thread-id>/session_transcripts/<thread-id>.jsonl
```

`<data-root>` 优先使用 `LXE_DATA_ROOT`；未设置时，源码运行默认使用仓库根下的 `var/`，独立调用打包程序默认使用资源根目录上一级的 `var/`。这与 Desktop 启动时解析并传入的用户数据目录不同，调用方应显式选择可写目录。路径解析见 [exec-paths.ts](../../../apps/agent-cli/src/exec-paths.ts)，Desktop 规则见 [程序与用户数据](../../desktop/data-location.md)。

`exec resume <thread-id>` 复用历史和创建时的工作区。显式传入 `-C` 时必须与该不可变工作区一致。`exec resume --last` 只查当前 Git worktree，按最近活动时间选择没有被其他进程占用的 thread。

每个 thread 目录有进程级独占锁；两个进程不能同时恢复同一 SQLite。进程已经消失的陈旧锁会在确认 PID 不存活后回收。`--ephemeral` 使用临时 SQLite，结束后删除，不能和 `resume` 同用。

CLI 为每个 thread 使用独立数据库，不复用 Desktop 的 `db/agent.sqlite3`；同一 thread 的并发恢复由上述独占锁控制。

## 权限与执行边界

CLI 复用 `AgentRuntimeHost` 的权限服务。新建会话默认使用 Workspace Write，恢复会话保留已存储的权限模式。`write`、`edit` 检查写入路径；`exec` 根据权限模式配置操作系统级文件写入限制。Workspace Write 以固定工作区限制写入范围，不随命令的 cwd 扩大。

独立 CLI 当前没有桌面的单次提权审批渠道，也没有切换权限模式的命令参数。受限模式需要可用的平台后端；缺失或失败会返回实际错误，不自动改成 Full access。平台限制、临时目录和权限覆盖范围统一见 [权限专题](permission-policy.md)，这些限制不等于读取、网络或完整进程隔离。

一次性 CLI 在 turn 结束后关闭宿主，因此会清理该 Runtime 持有的命令进程。通用的取消、观察和进程终止规则见 [exec 生命周期](tools/README.md#cancel-与-exec-生命周期)。

当前不支持 `--output-schema`、图片参数、逐次模型覆盖、GitHub Action 和系统 `PATH` 安装。
