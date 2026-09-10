# Tool Schema

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
- `platforms`：允许的当前回合来源；例如 `ask_user_question` 只允许 desktop。
- `supportsParallelCalls`：明确为 true 时可与相邻的同类调用并行；省略时独占执行。
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
- 相对路径的 workspace 基准与可接受的宿主绝对路径；workspace 不构成沙箱。
- `exec` 的 command、cwd 与 `yield-time-ms`（250–30000ms）；没有 background 或默认硬超时。
- `wait` 的 `exec_id`、`yield-time-ms`（5000–300000ms）与 `terminate`。
- 互斥参数或调用前提。

不要把 secret 默认值、真实 token、cookie 或本机私有路径写入 schema/description。

## 结构化提问 ask_user_question

输入为 `questions`，结果为 `answers[{id, selected, custom?}]`。Bun Runtime 负责问题归属、验证、一次性结算和取消；工具等待不采用普通短超时。完整输入输出与桌面协议见 [结构化提问](../../tool/ask-user-question.md)。

## 内容搜索 grep

复制代码搜索时可以直接使用原文模式：

```json
{ "pattern": "items[0]", "literal": true, "path": "src", "output_mode": "content" }
```

`literal` 默认 false，沿用正则语义。原文模式的 `items[0]` 匹配数组访问文本；正则模式的 `items[0]` 匹配 `items0`。要用正则搜索同一段原文，JSON 写成 `{ "pattern": "items\\[0\\]" }`。原文模式不解释正则特殊字符，不做 Unicode 或换行归一化，可与 `case_insensitive`、`multiline` 及三种输出模式组合。pattern 含实际 LF 时，原文模式要求 `multiline: true`；反斜杠和字母 n 组成的文本仍按两个字符查找。

只要求 `pattern`：必须为非空字符串，允许纯空白且不裁剪。省略 `path` 时使用当前会话目录；提供时必须为非空、非纯空白字符串，保留原路径。`glob`、`type` 必须为字符串，空字符串表示不筛选。`output_mode` 仅接受 `files_with_matches`（默认）、`content`、`count`。`literal`、`case_insensitive`、`multiline` 必须为布尔值，默认 false。

`head_limit` 默认 100，必须为正的安全整数；`context`、`before_context`、`after_context` 必须为非负安全整数。单侧参数覆盖该侧的 context，显式 0 也有效；上下文仅用于 content 模式，其余模式接受但不使用。schema 与执行端均拒绝未知字段、null、错误类型和无效数值，不隐式转换或静默修正。校验发生在路径解析及搜索之前；正则语法和 type 支持范围由实际后端判断，保留实际后端错误。

有 rg 时原文搜索使用 `--fixed-strings`，通过参数数组传递；无 rg 时将原文安全转义后复用内置匹配流程。搜索范围、忽略规则、隐藏文件行为以及多行展示和计数沿用各后端现状，不保证两种后端的这些行为完全一致。`head_limit` 限制的是输出行数，包含上下文，并非纯匹配数；工具层仍有 10,000 字符头尾截断，不提供连续分页。

## 路径搜索 find

```json
{ "pattern": "**/*.ts", "path": "src", "limit": 1000 }
```

find 使用固定版本 fd 10.5.0。pattern 必须是非空字符串，不裁剪；path 默认当前会话目录，提供时必须为非空、非纯空白字符串且指向目录；limit 默认 1000，必须为正的安全整数。schema 和执行端都拒绝未知字段、null、错误类型及无效数值。旧 head_limit 已移除，错误会提示改用 limit；历史记录不迁移。

匹配参考 PI：glob 模式，包含隐藏条目，遵守 fd 的 .gitignore/.ignore/.fdignore 等忽略规则，不再叠加旧的固定排除目录。没有关闭忽略规则的参数。Git 仓库内保留默认边界，非 Git 目录添加 --no-require-git。smart-case 默认忽略大小写，模式含大写字母时区分大小写。不限定类型，文件、目录和符号链接均可能返回，不跟随目录链接。

不含 / 的模式匹配名称；含 / 时匹配完整路径，必要时补 **/，Windows 转换分隔符。Windows 会展开 **/ 的零层与多层分支，并展平花括号组合后交给 fd；最多展开 256 个分支，超出时明确提示简化模式。含路径模式不承诺锚定搜索根，例如 src/**/*.ts 也可能匹配搜索范围内其他层级的 src。**/ 允许零层目录，支持花括号和字符类。项目内结果继续相对 workspace，外部结果为宿主绝对路径；不添加类型后缀。

fd 达到 limit 后提前停止，保留其输出顺序；不按修改时间排序，不提供 offset、不承诺重复调用顺序一致。达到条数时提示可能还有结果，不声称已知总数。用更具体的 pattern/path 或更大的 limit 重新查询。

子进程输出按 NUL 流式解析，路径不 trim；显示时转义反斜杠和控制字符。10,000 字符预算内只输出完整条目，预留错误和截断提示；字符上限触发时停止子进程并提示缩小范围，不再保留头尾片段。单条超长路径明确报错。显示转义用于避免一个名称占多行，调用文件工具时使用对应原文路径。

搜索启用 --show-errors。部分结果伴随错误会注明不完整并显示实际 stderr；无结果的执行失败、启动失败、超时和取消均明确失败。进程超时 30 秒，未完成路径缓冲上限 1 MiB，stderr 保留上限 64 KiB，展示再次截断时明确标记。主动达到预算后结束子进程不误报为异常退出。

fd 不在首次搜索时下载，也不回退旧遍历器。源码开发先运行 `bun run desktop:tools:fd`，可用 LXE_FD_PATH 明确覆盖；否则依次查当前 checkout 的受管理二进制和系统 fd/fdfind，版本必须匹配。macOS 的 desktop 开发/预览入口自动准备；Windows 构建从 fd.lock.json 准备，descriptor fd_path / 构建输入 LXE_DESKTOP_FD_PATH 指向待打包文件。应用使用 resources/runtime/tools/fd.exe 的明确路径，即使宿主 PATH 或配置有另一份 fd，也不覆盖携带版本。新 checkout 执行真实 find 测试前必须准备 fd，缺失会失败。

## 目录分页 ls

```json
{ "path": "./data", "limit": 500, "offset": 0 }
```

三个参数均可省略，默认当前会话目录、最多 500 条、跳过 0 条。`limit` 必须是正的安全整数，`offset` 必须是非负安全整数；`path` 若提供必须是非空字符串。schema 与执行端都拒绝未知字段和错误类型，不隐式转换或静默修正。旧的 `{}` 和仅传 `path` 的调用继续有效。

每次只列一层，包含隐藏条目，不递归、不应用 `.gitignore`。按原始名称的小写形式排序，同名时再比较原名，使用不依赖语言环境的字符串顺序，文件与目录混排。目录名加 `/`，符号链接加 `@`；用 Dirent 判断，不跟随链接查询，断链仍显示。反斜杠、换行、制表符及控制/格式字符转义显示，保证每个名称占一行；排序使用转义前的名称。

结果先报告当前范围与总数，再连续输出完整条目，最后报告结束或下一页位置。`offset` 从 0 开始，显示范围从 1 开始。条数上限或工具层 10,000 字符预算先到就停止；预算包含范围与续页提示。使用返回的 `Continue with offset=N` 继续，N 是原 offset 加上实际返回条数，不能用请求的 limit 自行推算。名称不切断、不跳过，不再保留头尾丢掉中间。

空目录明确报告总数 0；offset 达到或超过当前总数，返回无更多条目，不生成下一页提示。单个名称连同分页提示都无法放入预算时明确报错，不返回原 offset 引导无限重试。文件系统错误保留实际异常，不把权限错误当作空目录。

底层仍会读取整个目录再排序，不缓存、不建立跨页快照。目录未变化时，连续翻页无遗漏、无重复；两次调用间新增、删除或重命名条目可能改变位置，需要从 offset=0 重新查看。本次分页控制模型输出，不降低目录扫描成本；显示链路继续使用已有脱敏与截断策略。

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
