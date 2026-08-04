# Agent CLI exec

状态：Current

## 先说结论

`agent-cli exec` 是面向脚本和 CI 的一次性 Runtime 入口。一次命令只执行一个 turn，完成后关闭 Runtime；Desktop 继续使用长驻的 `agent-cli serve`，两者的协议、数据库和生命周期互不混用。

源码环境可从仓库根运行：

```bash
bun apps/agent-cli/src/main.ts exec "总结当前仓库"
printf '%s\n' "检查这些日志" | bun apps/agent-cli/src/main.ts exec -
bun apps/agent-cli/src/main.ts exec --json -C ./packages "检查类型边界"
```

当前安装包不会把 `agent-cli` 加入系统 `PATH`。打包环境需要显式调用应用携带的可执行文件；系统命令安装和 GitHub Action 不属于 v1。

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
var/db/exec-sessions/<thread-id>/agent.sqlite3
var/db/exec-sessions/<thread-id>/session_transcripts/<thread-id>.jsonl
```

`exec resume <thread-id>` 复用历史和创建时的工作区。显式传入 `-C` 时必须与该不可变工作区一致。`exec resume --last` 只查当前 Git worktree，按最近活动时间选择没有被其他进程占用的 thread。

每个 thread 目录有进程级独占锁；两个进程不能同时恢复同一 SQLite。进程已经消失的陈旧锁会在确认 PID 不存活后回收。`--ephemeral` 使用临时 SQLite，结束后删除，不能和 `resume` 同用。

CLI 数据库绝不打开 Desktop 的 `var/db/agent.sqlite3`，保持一个 SQLite 只有一个写入者。

## 安全边界与暂缓项

v1 只适用于可信本地自动化。文件、搜索、文件交付、shell、Python、MCP 和业务工具直接继承 agent-cli 进程的宿主用户权限；workspace 只是默认路径，不是安全边界。Runtime 不提供 sandbox、初始化检查或失败回退，也不等同于 Codex sandbox。不要在不可信仓库、Prompt 或 CI 输入上把它当成安全边界。

`--output-schema`、图片参数、逐次模型覆盖、GitHub Action 和系统 `PATH` 安装暂缓，分别需要 Provider 结构化输出、附件加载、非持久配置覆盖和独立发布安全设计。
