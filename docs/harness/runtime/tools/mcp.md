# MCP 配置、连接与工具适配

agentcli 负责 MCP 客户端。用户提供服务器配置后，Runtime 建立连接、发现工具，再把工具交给 Agent 的工具注册表。协议通信仍由官方 MCP SDK 完成。

## 从桌面添加服务

打开「能力 → MCP 服务 → 添加服务」。远程服务填写 URL，需要认证时可在「更多连接选项」指定令牌环境变量或请求头。本地程序填写可执行文件，每个启动参数单独添加一项。按需设置工作目录、环境变量或从 Agent 环境传入的变量。

保存后，agentcli 将服务写入用户 JSON 配置，默认启用并通过 `codemode` 暴露工具。宿主立即在后台连接新服务，不重启 Agent，也不取消正在进行的会话。已启用的间接服务在下一次模型请求的目录中可见；工具要等到握手和发现成功后才能调用。

在本机聊天里，助手用 `exec` 执行 `agent-cli mcp list` 查询共享连接，再用 `agent-cli mcp login <配置中的服务名>` 发起登录。用户在浏览器授权；若命令返回 `exec_id`，助手用 `wait` 等待。模型可以从系统提示词找到[随包命令说明](../../../../apps/agent-cli/docs/mcp.md)。

终端提供五个用户级命令，同一 LXE 数据目录的工作区共用配置，不读取项目级配置：

| 命令 | 用途 |
| --- | --- |
| `agent-cli mcp add <名称> --url <地址>` 或 `add <名称> -- <程序> [参数...]` | 添加或替换服务，只写配置。 |
| `agent-cli mcp remove <名称>` | 移除配置，保留已有授权。 |
| `agent-cli mcp list [--json]` | 列出状态、工具名和错误；有已启用的服务未就绪时返回退出码 1。 |
| `agent-cli mcp login <名称>` | 按需打开浏览器授权，验证连接。 |
| `agent-cli mcp logout <名称>` | 删除此服务在本机保存的 OAuth 凭据，保留配置。 |

聊天中的 `list` 查询现有连接；独立终端会临时连接已启用的用户服务，查询完即关闭，不启动 Agent，也不弹出登录页。桌面注入的 `lxe_desktop` 只存在于桌面宿主。独立终端的 `login` 只连接指定服务；运行中的 Harness 在下一次模型请求前同步同一数据目录的授权变化。命令行 `add/remove` 改文件，下次独立命令或启动 Harness 时读取；桌面表单添加仍即时生效。

## 配置文件

默认读取数据目录中的 `config/mcp_servers.local.json`；可用 `LXE_MCP_CONFIG_PATH` 指定另一个 JSON 文件。文件不存在或 `servers` 为空时，没有用户配置的服务器。桌面首次启动会复制空的默认 JSON 模板。

只支持 JSON。旧的 `mcp_servers.local.yaml` 不读取、不迁移、不删除；它里面的服务器不会自动连接。需要继续使用的服务，由用户写入 JSON 文件。显式指定的文件也按 JSON 解析，格式错误直接报告，不回退到其他文件。

```json
{
  "servers": {
    "local_demo": {
      "enabled": true,
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.js"],
      "env": { "SERVICE_API_KEY": "${SERVICE_API_KEY}" }
    },
    "remote_demo": {
      "enabled": true,
      "exposure": "deferred",
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": { "X-Client": "agentcli" },
      "bearer_token_env_var": "REMOTE_MCP_TOKEN"
    }
  }
}
```

`enabled` 必须显式写为 `true` 才会启动连接，省略时为关闭。stdio 必须有 `command`，HTTP 必须有 `url`。`args`、`env` 和 HTTP 请求头可省略。HTTP 凭据通过静态 `headers`、环境变量映射 `env_headers` 或 `bearer_token_env_var` 提供。

未显式配置 Authorization 的服务首次连接返回 401 时，桌面列表显示「需要登录」。用户点击「登录」或在桌面对话中明确要求助手登录后，才发起浏览器授权，完成授权后只重连该服务。服务签发刷新令牌时，LXE 会在访问令牌到期前 30 秒内的下一次请求中自动续期，并合并并发续期。工具请求收到 401 时，取得新令牌后最多重试该请求一次。对于已登录的服务，可以在列表中直接点击「重新登录」。浏览器登录完成后，之前失败的工具调用需重新发起。只接受固定令牌的服务仍通过配置请求头接入。

授权服务器签发令牌后，Harness 立即将 OAuth 凭据按服务名和 URL 保存到数据目录的 `config/mcp-auth.json`，与服务定义和模型 API Key 分开。文件使用 JSON 明文，POSIX 权限为 `0600`。登录和续期通过跨进程文件锁与原子替换保存。如果随后 MCP 握手或工具发现失败，连接状态显示实际错误，凭据保留。点击「重新连接」或再次运行登录命令会先用已存凭据重试；若服务仍要求授权，再打开浏览器。旧测试版本的桌面凭据需要重新登录一次。

配置层展开命令、参数和环境变量中的 `${VAR}`。HTTP 请求头里的占位符和令牌在连接时解析；写回开关不会把解析后的秘密写进文件。缺失变量会明确报错。

可选字段沿用现有行为：`startup_timeout_s` 默认 10 秒、`tool_timeout_s` 默认 60 秒；`enabled_tools` 与 `disabled_tools` 使用服务端原始工具名，禁用名单优先；`protocol_mode` 默认 `auto`，也可选 `legacy` 或固定的 `2026-07-28`。JSON 仍接受 `mcpServers` 作为 `servers` 的别名，两者不能同时出现。

配置在宿主启动时加载。桌面新增及启停操作会写回 JSON，并通知管理器改变运行状态；手动修改命令、地址等连接参数后需要重启 agentcli。重连使用已加载的配置，不负责重新读取文件。

## 四块职责

源码入口为 `packages/agent/runtime/src/tooling/mcp.ts`，实现位于同级 `mcp/` 目录。

| 文件 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| `config.ts` | 读取和校验 JSON、展开占位符、写回开关、解析 HTTP 请求头 | 不选择文件存放位置，不保存运行状态 |
| `connector.ts` | 封装 SDK，建立 stdio/HTTP 通信、协商协议、发现和调用工具、关闭连接、报告底层关闭 | 不重连、不注册 Agent 工具，不识别具体业务服务名 |
| `manager.ts` | 启停服务器、维护状态、处理超时与取消、手动重连、注册和移除工具 | 不读写配置文件，不自动重试 |
| `tool-adapter.ts` | 工具过滤、唯一命名、绑定原始工具名、转换调用结果与实际错误 | 不创建连接，不决定连接生命周期 |

`apps/agent-cli/src/runtime-host.ts` 选择配置路径并组装这些模块。`lxe_desktop` 继续通过宿主注入，开关仍由桌面保存；它的凭据和连接定义不写入用户 JSON。

## 连接管理

管理器为每个服务提供 `status(name)`，其中 `state` 表示当前状态：

| 状态 | 含义 |
| --- | --- |
| `configured` | 已加载配置，尚未启动，或管理器已经停止 |
| `disabled` | 用户未启用 |
| `needs_auth` | HTTP 服务拒绝未授权的连接，等待用户登录；服务名保留在目录，尚未注册工具 |
| `connecting` | 正在准备连接、协商协议并发现工具 |
| `ready` | 连接已经建立，发现的工具已注册；也允许服务没有工具 |
| `error` | 本次连接或注册失败，`error` 保存实际诊断 |
| `disconnected` | 已建立的连接收到 SDK 关闭通知 |

收到关闭通知时，管理器立即移除该连接注册的工具。这里表示 SDK 已观察到连接关闭；HTTP 服务暂时不可达、单次请求失败，不一定意味着整个连接已经关闭。本轮不新增心跳探测。

`setEnabled(name, false)` 会取消启动或关闭连接、移除工具。`setEnabled(name, true)` 对尚未连接的服务发起连接；已经连接时不重复建立。`reconnect(name)` 主动替换已启用服务的连接并重新发现工具，不修改开关，不自动启用关闭的服务。该方法目前供宿主代码调用，没有新增桌面重连按钮或 RPC。

停用、停止和重连会使旧的连接尝试失效。旧连接迟到的结果会被关闭，旧回调不能清理新连接的工具。关闭等待有 5 秒上限，超过上限记录实际超时，避免阻塞其他服务器清理；这不代表一个失控的外部进程一定已经退出。

工具执行失败会返回经过必要脱敏和显式截断的实际错误，并保留最后一次失败诊断；单次工具失败不会把状态从 `ready` 改为 `disconnected`。开始新的连接尝试会清空旧诊断。

## 工具适配与上下文的边界

模型工具名采用 `mcp__<server>__<tool>`。例如，服务 `team-skills` 的工具 `list-skills` 在服务目录中归入 `mcp__team_skills`；工具搜索和直接声明都使用 `mcp__team_skills__list_skills`，脚本可以原样写 `tools.mcp__team_skills__list_skills({})`。统一成下划线是为了让模型看到的名字也是合法的 JavaScript 标识符。配置、登录和工具过滤仍使用原名；发给该服务的 `tools/call.params.name` 仍是 `list-skills`。

服务名不能仅靠 `-` 和 `_` 区分（如 `team-skills` 与 `team_skills`），否则会占用同一目录名。工具名过长或规范化后重名时会附加哈希，调用和清理按实际注册的名字定位，不从模型名反推原名。

工具适配保留描述、参数 Schema、平台限制及宿主提供的调用元数据。

每个服务可以通过 `exposure` 指定模型如何发现工具。

| `exposure` | 启用服务后，当前平台的模型入口 |
| --- | --- |
| `codemode`（默认） | 提供 `codemode`。脚本用 `searchTools()` 发现工具，再用 `tools[name](args)` 调用。脚本搜索保持模型可直接调用的工具清单稳定。 |
| `deferred` | 提供 `tool_search`。模型搜索后，命中的工具从下一步开始可直接调用。 |
| `direct` | 连接成功后，模型可直接调用具体工具。 |
| `hidden` | 工具保留在管理目录中，模型和脚本均无法调用。 |

旧值 `auto` 随默认策略走 `codemode`，已有文件按原样保留。只统计当前回合平台上**已启用**的服务，连接状态决定实际可用的工具。两种间接模式并存时，两个入口都会出现。`tool_search` 可加载 `codemode` 和 `deferred` 工具，脚本可调用当前平台允许的非隐藏 MCP 工具。关闭最后一个 `deferred` 服务后，下一次模型请求就会撤下 `tool_search`。详见 [Exposure 模型](README.md#exposure-模型) 和 [桌面 MCP 接口](../../../desktop/automations.md#桌面-mcp-接口)。

### 在 codemode 中查找和调用工具

agentcli 在 `mcp_servers` 目录中列出当前平台已启用的 `codemode` 和 `deferred` 服务。每行给出命名空间、发现入口和一句简介，例如 `- mcp__lxe_desktop (codemode): Manage scheduled tasks in the desktop app.`。简介优先取配置 `connector_description` 的首行，其次取当前连接的服务端 instructions 首行。两者都为空时只列名称和入口。没有符合条件的服务时省略整段。

第一轮把目录放在初始指令里。后续每一步模型调用重新检查目录，即使仍在同一轮内。支持中途指令的模型会在观察到变化的位置收到新版目录，最后一个服务撤下时会收到目录已清空的说明。其他模型在开头的指令里收到最新目录。续聊和分叉按各自的历史回放，压缩摘要保存截断处生效的目录和工具清单。各模型的请求布局见 [模型目录与选择](../../llm/provider_catalog.md)。

`codemode` 启用时，系统指令建议用 `Promise.allSettled` 批量执行独立调用、按顺序串联有依赖的调用，或先在脚本里筛选大量结果。模型可以直接调用、同时也能在脚本里调用的工具，会在各自的描述末尾注明脚本调用方式和返回类型。例如 `tools.read(args)` 返回字符串或图片对象。通过 `tool_search` 加载的 MCP 工具也遵循同一规则。

`tool_search` 与脚本里的 `searchTools()` 共用 BM25，索引工具名、描述、参数和所属服务的信息。`tool_search` 只搜索当前分支尚未向模型声明的可用间接工具，默认最多加载 8 个。每个命中项只返回名称和首行简介，完整声明从下一次模型请求起生效。脚本搜索可以反复查询已加载的工具，查询本身不会加载它们。

成功加载的工具记入 transcript。续聊或从加载之后的轮尾分叉时，agentcli 按当前注册表、平台和权限恢复声明；从更早的轮尾分叉只继承当时已加载的工具。新记录从本版本开始写入，旧版搜索结果保留在原对话历史中。

`searchTools(query, { limit?, namespace? })` 按 BM25 排序，默认返回前 8 个匹配。每个匹配包含可调用的 `name` 和带 TypeScript 签名的 `description`。已知名称时，`describeTool(name)` 可直接查询同一份声明。`describeNamespace(name)` 返回当前脚本可见的服务简介、服务端指引（如有）及工具名。查询不到的工具或服务返回 `undefined`。

```js
const [hit] = await searchTools("automation_list", { namespace: "lxe_desktop", limit: 1 });
if (!hit) return [];
const result = await tools[hit.name]({});
if (result.isError) return result.content;
return result.structuredContent ?? JSON.parse(result.content[0].text);
```

脚本能读取 MCP 原始内容块和结构化值。服务返回的 `isError: true` 仍是脚本可读取的结果，错误内容沿用凭据脱敏规则。连接异常、协议失败、超时和取消会拒绝调用。宿主元数据 `_meta` 留在客户端。模型直接调用 MCP 工具时继续收到适合展示的内容或错误。

脚本也能组合当前会话的内置工具。普通会话用 `tools.exec` 列目录、找文件或搜索内容。`edit`、`write` 返回修改或写入摘要。`read` 读文本时返回不带行号的字符串，仍受分页和输出上限约束；读图片时返回 `{ type: "image", data, mimeType, note }`，可用 `image(await tools.read({ path: "photo.jpg" }))` 将图片交给模型。新文件可用 `tools.write({ file_path, content })` 创建。覆盖或编辑已有文件沿用同一会话的权限和版本检查，先读再改。写入立即生效。

`exec` 返回包含 `status`、`exec_id` 和 `output` 的对象。如果命令仍在运行，脚本可以调用 `tools.wait({ exec_id })` 取得新增的 `new_output`，或先把 ID 返回给模型，让同一会话稍后继续等。进程退出后可读取 `exit_code`，包括非零退出码。显式传入 `terminate: true` 可终止该进程树。

```js
const first = await tools.exec({ command: "bun test", "yield-time-ms": 1000 });
if (first.status !== "running") return first;
const next = await tools.wait({ exec_id: first.exec_id, "yield-time-ms": 5000 });
return { ...next, output: first.output + next.new_output };
```

同一个 agent-cli 进程默认最多同时运行 2 个脚本，所有会话按请求到达顺序排队。可用 Pi 的环境变量 `PI_CODEMODE_MAX_WORKERS` 指定正整数上限。排队最多等待 60 秒，期间停止回合会立即移出队列。设置 `timeout_ms` 时，排队和执行共用这份时间预算。已经启动的 worker 退出后才释放名额。

脚本执行默认不限时，单个 QuickJS 堆内存上限为 256 MiB。可在脚本第一行设置本次超时和返回给模型的文本预算，例如：

```js
// @options: {"timeout_ms": 30000, "max_output_tokens": 1000}
text(await tools.read({ path: "README.md", limit: 20 }));
```

`max_output_tokens` 默认和最高都是 10,000，填入更大的整数按 10,000 执行。文本超过脚本预算，或先碰到 Agent 通用工具结果的 UTF-8 字节上限时，会保留首尾，并把全文写入系统临时文件。工具结果中的 `Full output` 给出绝对路径，可用 `read` 配合 `offset`、`limit` 分段读取。预算为 0 时，有文本的结果直接给出截断提示和路径。

脚本报错时，工具结果按顺序保留已经产生的文本和图片，再附上实际错误，并标记为失败。同样的文本预算也适用于失败结果，临时文件包含已输出的文本和错误诊断。

### 在多次脚本调用之间保存数据

脚本可用 `store("taskIds", ["a", "b"])` 保存少量 JSON 数据，同一脚本和本对话后续脚本都能用 `load("taskIds")` 读取。同名写入会覆盖旧值，`store("taskIds", undefined)` 删除该键。读取缺失的键返回 `undefined`。当前 Pi 1.5.0 的沙箱无法跨调用保存名为 `__proto__` 的键。

每个成功且有写入的脚本向会话 transcript 追加一条内部记录。脚本报错或执行中被停止时，本次写入会丢弃。重开对话可以恢复已保存的值；从轮尾分叉会继承截至该轮的值，之后两边独立读写。存储记录不会自动进入模型消息，脚本可以用 `return` 或 `text()` 展示需要的部分。
