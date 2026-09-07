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

## 批量编辑 edit

```json
{
  "path": "src/app.ts",
  "edits": [
    { "oldText": "before", "newText": "after" },
    { "oldText": "another original block", "newText": "" }
  ]
}
```

`path` 必须是非空字符串，`edits` 至少一项；每项只接受字符串 `oldText/newText`。旧文本不能为空，新文本为空表示删除。运行时拒绝未知字段、缺失参数和隐式类型转换。旧 `file_path/old_string/new_string/replace_all` 格式已移除，错误会给出新格式示例；历史调用记录不迁移。

每项针对同一份原文匹配，不能依赖前一项生成的内容。匹配区间允许相邻，不能交叉、重复或互相包含；同一行可以有多处不重叠修改。重复文本需要增加上下文定位，不能要求替换全部。任何一项失败都不写文件。

匹配前统一 LF/CRLF/CR 并暂时移开 BOM。精确匹配优先，失败后采用 PI 风格的 NFKC、行尾空白、Unicode 引号、破折号和特殊空格归一化。唯一性按归一化文本保守检查；目标归一化后为空也会拒绝。任一项需要宽松匹配时，整批在同一归一化文本中定位。归一化只写回修改涉及的行，未修改行的字符保留；替换内容按普通文本写入，`$&/$1` 没有特殊意义。

写回恢复 BOM，统一使用文件首个换行的 LF/CRLF 风格（单独 CR 或无换行默认 LF）；不保留混合换行样式。仍要求当前 Session 有有效的 read/write 版本记录，写入前再次检查版本和取消状态，成功后更新账本。这是写入前的检查，不是跨进程事务或断电保护。

返回文本包括编辑项数、首个修改行号、使用宽松匹配的项和带行号的差异摘要。上下文每侧最多 3 行，相邻片段合并；`-` 行号对应原文，`+` 行号对应新文件，上下文使用原文行号。宽松匹配引起的行内字符变化也显示；全文件换行统一会单独注明。摘要按完整行限制在 10,000 字符内，超过时提示用 `read` 继续检查；不影响实际编辑结果。显示链路仍使用现有脱敏和截断逻辑。

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
