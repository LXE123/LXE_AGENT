# Tool Execution

状态：Current

## 目的

Tool execution 把 provider 的 `tool_use` 转为受控本地调用，并确保 cancel、error、artifact、state patch、usage 和 canonical result 在所有来源上保持一致。

## Dispatch 前检查

Runtime 只 dispatch 当前 assistant message 中结构有效的 tool use。每个调用前：

1. 检查 turn abort。
2. 消费 steering；若用户改变计划，剩余调用写 skipped result。
3. 在当前 exposure state 中验证工具可见。
4. 验证 input 为 object。
5. 建立 tool trace、display step 和 usage timer。

未知或未暴露工具不能通过直接构造 name 绕过 schema。

## Native 工具

Native handler 与 Runtime 同进程执行。Coding tools 包括 read、write、edit、grep、find、exec、wait 和 send_files：

- 路径先相对 Session working directory 解析；绝对路径、`~`、`..` 和跨 workspace 符号链接都交给宿主文件系统处理。
- read/write/edit/grep/find/ls/send_files 和 `exec.cwd` 可以访问 LXE Agent 进程用户有权访问的任意宿主路径；OS 拒绝时只对敏感值做统一脱敏和显式截断，`EACCES`、`EPERM` 等实际系统错误不会改写成泛化提示。
- read 输出稳定行号，并记录 session read version。
- 修改现有文件要求 read-before-modify；外部 mtime/content 变化导致 stale edit。
- binary 不通过文本 read；一个或多个 artifact 使用 `send_files(paths=[...])` 一次交付。
- `exec` 观察到 `yield-time-ms` 后仍未结束会返回 `status=running` 和 `exec_id`；Session manager 继续持有命令。
- `wait` 对同一 `exec_id` 串行观察，对不同 id 可并发；终态只返回一次，之后模型侧句柄关闭。

Process stdout/stderr 使用有界内存尾部和落盘截断机制。Turn cancel 只中止本次观察，不终止已经创建的 exec；Session 删除、Runtime 停止或 `wait(terminate=true)` 才终止完整进程树。

## MCP 工具

`McpManager` 读取 local YAML，替换环境占位并连接 enabled stdio 或 streamable-http server。每个 server 独立 startup timeout；失败只记录 server error，不阻塞 Runtime start。

Tool call 使用 server-specific timeout 和 turn abort signal。调用失败更新 MCP status 并返回 tool error。Enable/disable 会注册或移除该 server definition，不在 Dashboard PATCH 时隐式调用模型。

## lxeskill 业务命令

业务能力不注册为独立 model tool。模型通过 native `exec` 执行一条独立的 `lxeskill ...` 命令：

- `catalog.json` 决定稳定 command path、owner skill、业务 module 和 artifact 声明。
- `exec.command` 只允许一条独立的 `lxeskill` 调用；拒绝 `python -m`、内部业务 module、管道、重定向和 shell 拼接。
- Gateway policy 决定允许的 skill types；`AgentRuntimeHost` 生成实际 skill scope，Runtime exec adapter 注入 `LXESKILL_SKILL_SCOPE`。CLI 负责命令授权、参数校验和业务 dispatch。
- Desktop 优先使用 `LXE_MANAGED_PYTHON` 指向的应用私有 Python；源码开发才回退到项目 `.venv`。cwd、yield observation、output limit、Session ownership 和 Windows process tree 由 native process manager 处理。
- CLI 保留版本化 JSONL/result/artifact 合同，Runtime 将 stdout/stderr 作为受控 process output 返回。

Skill 只能调用自己声明且由 catalog 归属的命令；生成文件和其它可读普通文件都可直接通过 `send_files` 发送。

## State patch 与 artifact

Handler result 可以包含：

- `state_patch`：Runtime 调用 store 做 object merge。
- `files`：通过 `emit_kind=tool` 立即交给 GatewayEmitter。
- `content`：进入模型可见 tool result。

Artifact delivery 与工具业务执行分离。发送失败会报告 delivery error，但不得自动重跑已成功生成文件的工具。

## Result closure

成功 result 使用原 `tool_call_id`。异常转换为 `is_error=true`。未分类异常把经过脱敏和有界截断的实际 `Error.message` 放入统一 `ToolFailureDetails.observed_message`，同时标记 `cause_known=false`、`retryability=unknown` 和 `inference_policy=verified_reason_only`；它不会用“原因未知”等占位文本替换实际错误。只有本地确定性错误码，或 operation 加明确 provider code/subcode 的 fixture-backed 精确映射，才允许设置 `cause_known=true`、`verified_reason` 与 `mapping_id`。多个调用的 results 作为一个 tool message append；cancel 或 steering 会为尚未执行的调用生成 closure stub。Anthropic 的 `tool_use_id` 只存在于 Provider adapter 生成的 wire request。

Oversized content 在 append 前由 ContextPipeline 以总文本 10k token 预算裁剪。Image block 保留给当前 turn，并单独计 token。

## Display 与日志

`tool-display.ts` 生成 CardKit step：

- detail 默认限制 240 chars。
- full mode 才展示 result detail，最大 4000 chars。
- error detail 最大 2000 chars。
- 路径、secret、cookie、authorization 和大型 payload 被脱敏/截断。

Model-visible result、用户展示和运行日志是三个不同输出，不能互相直接复用。

其中模型只能根据 `verified_reason` 陈述原因。HTTP status、异常文本、平台 fallback、旧 transcript 中的 assistant 判断，以及 `[Unable to download ...]` 一类历史占位符都只是观测事实，不能升级为权限、过期、网络、格式或客户端版本诊断。用户卡片只显示稳定的安全提示；provider code、log ID 和诊断上下文进入结构化结果或日志。

## Usage

Runtime 按 tool name 记录 calls、errors、duration；当前已激活 owner skill 同步累计 usage。Turn 完成后批量写入 usage tables，Dashboard 可按时间和 skill/tool 查询。

## Failure 语义

- Tool error 不使 Bun 进程退出，模型可以在下一 step 恢复。
- 原因未知必须明确写成未知；不能为了“可读”而补写未经验证的归因。
- 已分类错误保留确定的 `verified_reason` 和 retryability，模型可以据此采取下一步。
- Abort 不继续 dispatch 剩余调用。
- 异步 exec 完成只发 UI 事件更新原工具卡，不进入模型消息，不创建 pending event，也不唤醒模型。
- MCP/server failure 隔离到对应 connector。
- `lxeskill` 非零退出或非法调用不接受为成功结果。
- Artifact send failure 不改变 canonical tool result 已执行事实。

## 验证

Tests 覆盖宿主路径访问、read-before-edit、exec/wait 生命周期、跨 Session 隔离、进程树终止、tool search、MCP timeout/disable、独立 `lxeskill` 命令约束、skill ownership、result trimming、cancel closure 和 artifact ordering。
