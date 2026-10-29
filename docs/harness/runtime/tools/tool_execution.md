# Tool Execution

## 目的

Tool execution 把 Provider 归一化后的 `tool_call` 转为受控本地调用，并确保 cancel、error、artifact、state patch、usage 和 canonical result 在所有来源上保持一致。

## Dispatch 前检查

Runtime 只 dispatch 当前 assistant message 中结构有效的 tool use。每个调用前：

1. 检查 turn abort。
2. 消费 steering；若用户改变计划，剩余调用写 skipped result。
3. 在当前 exposure state 中验证工具可见。
4. 验证 input 为 object。
5. 建立 tool trace、display step 和 usage timer。

未知或未暴露工具不能通过直接构造 name 绕过 schema。

执行按原调用顺序分组：相邻且声明 `supportsParallelCalls=true` 的调用可并行；其他调用独占执行，不能跨它们合并并行组。结果按原调用顺序闭合。`ask_user_question` 不参加并行执行，详见 [结构化提问](ask-user-question.md)。

## Native 工具

Native handler 与 Runtime 同进程执行。Coding tools 包括 read、write、edit、grep、find、ls、exec、wait 和 send_files：

- 路径先相对 Session working directory 解析；绝对路径、`~`、`..` 和跨 workspace 符号链接都交给宿主文件系统处理。
- 读取、搜索、文件交付和 `exec.cwd` 的路径访问受宿主用户的操作系统权限约束；`exec`、`write`、`edit` 的写入还需应用 [会话权限策略](../permission-policy.md)。指定工作区外的 cwd 不会扩大写入范围。`EACCES`、`EPERM` 等实际系统错误按 [AGENTS.md](../../../../AGENTS.md#红线违反--生产事故)保留，不改写成泛化提示。
- read 输出稳定行号，并记录 session read version。
- 修改现有文件要求 read-before-modify；外部 mtime/content 变化导致 stale edit。
- binary 不通过文本 read；一个或多个 artifact 使用 `send_files(paths=[...])` 一次交付。
- `exec` 观察到 `yield-time-ms` 后仍未结束会返回 `status=running` 和 `exec_id`；Session manager 继续持有命令。
- `wait` 对同一 `exec_id` 串行观察，对不同 id 可并发；终态只返回一次，之后模型侧句柄关闭。

Process stdout/stderr 使用有界内存尾部和落盘截断机制。取消观察、进程终止及后台完成通知统一见 [exec 生命周期](README.md#cancel-与-exec-生命周期)。

## MCP 工具

`McpManager` 读取 local YAML，替换环境占位并连接 enabled stdio 或 streamable-http server。每个 server 独立 startup timeout；失败只记录 server error，不阻塞 Runtime start。

Runtime 使用官方 `@modelcontextprotocol/client` 2.3.1，支持 MCP `2026-07-28`，并兼容 SDK 支持的旧版服务。测试服务使用同版本 `@modelcontextprotocol/server`；生产运行不依赖测试服务。

每个 server 可设置 `protocol_mode`：

| 值 | 连接行为 |
| --- | --- |
| `auto`（默认） | 通过 `server/discover` 识别新版；按 SDK 协商规则连接旧版服务。 |
| `legacy` | 直接使用旧版 `initialize` 握手，适用于不接受新版探测的服务。 |
| `2026-07-28` | 要求服务支持该版本，不满足时连接失败。 |

既有 YAML 不需要迁移，省略字段就是 `auto`。新版消息、版本信息和取消协议由 SDK 负责；不手工修改版本字符串来模拟支持。探测超时为 `min(2 秒, startup_timeout_s / 2)`，不重复探测，整个连接与工具发现仍受 startup timeout 限制。STDIO 自动协商可能先启动一个短暂的探测子进程；禁用、超时或退出会关闭探测及会话连接。

认证失败、服务端异常和 HTTP 网络超时会保留实际错误，不通过回退旧版掩盖。赛狐连接继续使用原来的设备认证和直连适配，不添加 token 或 cookie。日志 `mcp_connected` 中的 `protocol_version`、`protocol_era` 记录实际协商结果；排查兼容问题时先查看连接错误和这些字段，再决定是否对该服务设置 `legacy`。

Tool call 使用 server-specific timeout 和 turn abort signal。调用失败更新 MCP status 并返回 tool error。Enable/disable 会注册或移除该 server definition，不在 Dashboard PATCH 时隐式调用模型。

工具列表分页由 SDK 聚合。`structuredContent` 按 JSON 值保留，包括数组、`null`、`false`、`0` 和空字符串，并转为模型可读的结果文本进入现有历史流程。图片继续走既有归一化和持久化流程。工具返回 `isError=true` 或 SDK 抛错时均按失败处理；错误状态保留 SDK 的诊断 `data`，经过脱敏和带标记的长度截断，不用空结果代替实际错误。工具错误通过 Runtime 的结构化错误路径进入模型与历史，避免通用错误摘要再次静默截断；原异常保留在 `cause` 中。

升级参考：[协议规范](https://modelcontextprotocol.io/specification/2026-07-28)、[SDK v2 迁移指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html)、[协议协商](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)。

## lxeskill 业务命令

业务能力不注册为独立 model tool。模型通过 native `exec` 执行 `lxeskill ...` 命令：

- lxeskillCLI 内部的 `catalog.json` 决定 command path、owner skill、业务 module 和 artifact 声明。agentcli 不读取该文件。Electron 通过 `lxeskill list` 获取命令列表，模型按需使用 `list`、`describe`、`datasets list`。
- `exec` 按通用权限与沙箱规则执行命令，按 PATH 解析 `lxeskill`，不改写为指定 Python 启动，也不添加命令形状限制或 Python 模块拦截；推荐调用方式写在 Skill 中。
- Desktop 下发服务器验证的业务权限决定允许的 skill types；`AgentRuntimeHost` 生成实际 skill scope，Runtime exec adapter 注入 `LXESKILL_SKILL_SCOPE`。CLI 负责命令授权、参数校验和业务 dispatch。
- Desktop 优先使用 `LXE_MANAGED_PYTHON` 指向的应用私有 Python；源码开发才回退到项目 `.venv`。cwd、yield observation、output limit、Session ownership 和 Windows process tree 由 native process manager 处理。
- CLI 保留版本化 JSONL/result/artifact 合同，Runtime 将 stdout/stderr 作为受控 process output 返回。
- agentcli 不执行 lxeskill 启动探测，也不缓存可用性来拦截调用。每次 `exec` 使用当时的执行环境并返回实际结果；桌面的 CLI 状态检查由 Electron 独立负责。

lxeskillCLI 根据注入的 Skill 范围校验命令归属；生成文件和其它可读普通文件都可直接通过 `send_files` 发送。

## State patch 与 artifact

Handler result 可以包含：

- `state_patch`：Runtime 调用 store 做 object merge。
- `files`：通过 `emit_kind=tool` 立即交给 GatewayEmitter。
- `content`：进入模型可见 tool result。

Artifact delivery 与工具业务执行分离。发送失败会报告 delivery error，但不得自动重跑已成功生成文件的工具。

## Result closure

成功 result 使用原 `tool_call_id`。异常转换为 `is_error=true`。未分类异常把经过脱敏和有界截断的实际 `Error.message` 放入统一 `ToolFailureDetails.observed_message`，同时标记 `cause_known=false`、`retryability=unknown` 和 `inference_policy=verified_reason_only`；它不会用“原因未知”等占位文本替换实际错误。只有本地确定性错误码，或 operation 加明确 provider code/subcode 的 fixture-backed 精确映射，才允许设置 `cause_known=true`、`verified_reason` 与 `mapping_id`。多个调用的 results 作为一个 tool message append；cancel 或 steering 会为尚未执行的调用生成 closure stub。Anthropic 的 `tool_use_id` 只存在于 Provider adapter 生成的 wire request。

Oversized content 在 append 前由 ContextPipeline 以总文本 10k token 预算裁剪。Image block 单独计 token，原始内容按 [图片持久化规则](../context/context_persistence.md#图片与敏感数据)保存；后续模型视图由上下文处理决定。

## Display 与日志

`tool-display.ts` 生成 CardKit step：

- 普通 detail 默认限制 240 chars；exec 的命令文本保留以便核对实际执行内容。
- full mode 才展示 result detail，最大 4000 chars。
- error detail 最大 2000 chars。
- 内部展示正文统一使用 `content`，根据状态生成成功或错误正文块。桌面和飞书均保留原始路径，不再缩短目录；现有敏感信息脱敏和长度截断继续生效。不能把工具卡当作任意输入的脱敏导出。诊断日志的路径脱敏独立处理。

Model-visible result、用户展示和运行日志是三个不同输出，不能互相直接复用。

其中模型只能根据 `verified_reason` 陈述原因。HTTP status、异常文本、平台 fallback、旧 transcript 中的 assistant 判断，以及 `[Unable to download ...]` 一类历史占位符都只是观测事实，不能升级为权限、过期、网络、格式或客户端版本诊断。用户卡片按展示设置显示有界的实际错误信息；结构化结果与日志保留经过必要脱敏的诊断。只有固定形状且有 fixture 或集成测试证明语义等价的错误，才可采用固定替代文本。

## Usage

Runtime 的独立统计组件在工具执行前观察调用：`read` 命中已发现的 Skill 路径时，每次计一次读取；`exec` 简单识别以 lxeskill 开头的命令。回合收尾时通过 `lxeskill list` 的归属字段记录 Skill 命令调用次数，不推断成功、失败或耗时。查询失败只记录日志，不影响工具调用。通用工具仍记录 calls、errors、duration。数据继续写入原有 usage tables。

## Failure 语义

- Tool error 不使 Bun 进程退出，模型可以在下一 step 恢复。
- 原因未知必须明确写成未知；不能为了“可读”而补写未经验证的归因。
- 已分类错误保留确定的 `verified_reason` 和 retryability，模型可以据此采取下一步。
- Abort 不继续 dispatch 剩余调用。
- MCP/server failure 隔离到对应 connector。
- `lxeskill` 非零退出或非法调用不接受为成功结果。
- Artifact send failure 不改变 canonical tool result 已执行事实。

## 验证

Tests 覆盖宿主路径访问、read-before-edit、exec/wait 生命周期、跨 Session 隔离、进程树终止、tool search、MCP timeout/disable、通用命令执行、Skill 调用统计与 CLI 归属查询、result trimming、cancel closure 和 artifact ordering。
