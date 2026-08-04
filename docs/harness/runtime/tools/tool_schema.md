# Tool Schema

状态：Current

## 目的

Tool schema 是 provider 可见的调用合同。它必须与 handler input 边界一致，同时允许 Runtime 在不把全部工具塞进 prompt 的情况下按 policy、skill 和搜索结果逐步暴露能力。

## ToolDefinition

Registry definition 包含：

- `name`：模型调用的唯一名称。
- `rawName`：可选原始 MCP 名称。
- `description`：用途、输入前提和结果说明。
- `input_schema`：JSON Schema object。
- `source`：native 或 MCP 来源。
- `exposure`：direct 或 deferred。
- `connectorName`：可选 connector/server identity。
- `ownerSkills`：允许激活该工具的 skill names。
- `execute`：不进入 provider schema 的本地 handler。

Provider 只接收 name、description 和 input schema；handler、source metadata 和本地路径不序列化到请求。

## 命名规则

所有 model name 在一个 registry 中全局唯一。重复注册直接抛错。MCP 名称先规范化 server/tool，再检查冲突并生成稳定唯一名；Dashboard 同时保留 raw/model mapping 便于诊断。

`lxeskill` 业务命令不是独立 `ToolDefinition`；它们的 command path 来自版本化 catalog。Skill frontmatter 的 `commands` 必须引用 catalog 中归属于该 skill 的业务命令，模型统一通过 native `exec` 调用。

## JSON Schema

Input schema 顶层应为 object，明确 properties、required 和 additionalProperties 策略。Handler 仍需做运行时类型和业务验证，因为 provider 可能返回不符合 schema 的 JSON。

Schema 应描述：

- 必填参数和允许类型。
- enum/范围/格式约束。
- 路径是 workspace-relative 还是绝对 artifact path。
- `exec` 的 command、cwd 与 `yield-time-ms`（250–30000ms）；没有 background 或默认硬超时。
- `wait` 的 `exec_id`、`yield-time-ms`（5000–300000ms）与 `terminate`。
- 互斥参数或调用前提。

不要把 secret 默认值、真实 token、cookie 或本机私有路径写入 schema/description。

## ExposureState

每个 turn 根据 bot policy、connector state 和允许 skill 创建 exposure state。`schemas()` 只返回：

1. policy 未禁用的 definition。
2. direct 或已通过 search 暴露的 definition。
3. 无 owner，或 owner skill 已激活的 definition。

State 记录 exposed names 与 active skills，不修改全局 registry。不同 session/turn 不共享模型可见集合。

## Deferred search

`tool_search` 按 name、description 和 parameter 文本匹配 deferred tools。命中会更新本 turn exposure，但当前 provider response 不能立即调用新工具；下一 step 重新生成 schemas 后才合法。

搜索结果应返回可读名称和说明，不包含 handler、secret config 或 MCP transport details。

## Skill activation

System prompt 只列允许的 skill manifest 路径。repository root 与 workspace root 分离时使用 manifest 的规范绝对路径；同根时保留 workspace-relative 路径。模型通过 read 加载某个 `SKILL.md` 后，coding read hook 验证该 manifest 在当前 allowed set，再激活 owner tools。

`read`、`write`、`edit`、`ls`、`grep`、`find`、`send_files` 和 `exec.cwd` 都可显式访问 LXE Agent 进程用户有权访问的宿主路径。相对路径以 Session working directory 为基准；外部搜索和文件交付结果使用绝对路径。workspace、repository skills、用户 skills 与 runtime artifacts 的分类只用于展示和 Skill 激活，不提供读写隔离。

Repository skill 同名优先于用户 skill；重复同来源 name/command、越界 reference 或缺失文件导致 catalog error。激活事件进入 skill usage。

## MCP schema

MCP tool 的 input schema 从 server discovery 返回。无 schema 时使用空 object schema。Disabled tool、enabled allowlist 和 server exposure 在注册前应用；连接失败的 server 不提供 schemas，但不阻塞其它 server 或 native tools。

## 版本与兼容

Provider request 使用当前 step 的 snapshot。更新 schema 不迁移 transcript，因为 history 只保存实际 tool name/input/result。删除或重命名工具时，旧 history 仍可 replay，但新 provider request不能再次调用不存在的 definition。

## 验证

Tests 覆盖重复 name、direct/deferred exposure、skill activation、MCP naming、command catalog ownership、connector filter 和 schema snapshot 时机。
