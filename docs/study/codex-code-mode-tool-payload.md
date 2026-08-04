# Codex code mode：模型实际看到的工具载荷

状态：Reference（外部项目研究笔记）

研究对象：`gpt-5.6-sol`（`tool_mode = code_mode_only`）下，Codex 发给模型的工具定义。

源码位置：`/Users/llxx/Projects/learning/agent/codex`

## 保真度声明（先读这段）

**不存在一份「唯一正确」的完整文本。**`exec` 的 `description` 是每次会话现场拼装的，随以下因素变化：

- 当时启用了哪些嵌套工具（config、插件、MCP server）
- 哪些工具走 `defer_loading`（不写进描述）
- `yield_time_ms` 的默认值（会替换模板里的字面量）
- 是否存在 MCP 工具（决定要不要插入 TypeScript 前言）
- namespace 分组情况

因此本文的组织方式是：**逐字给出每一块固定素材 + 给出确切的拼装算法**。下文标注「逐字」的代码块，均由脚本从 Rust 源码的字符串字面量中直接提取，未经人工转录。

---

## 一、模型看到的工具列表结构

`code_mode_only` 下模型的工具列表**只有两个条目**。凡是「可在 code mode 中使用」且「属于嵌套工具」的，都会从模型可见的 spec 列表中剔除（`core/src/tools/spec_plan.rs` 的 `is_hidden_by_code_mode_only`）。

`````jsonc
"tools": [
  { "name": "exec",  "description": <见第二节>, "format": { "type": "grammar", "syntax": "lark", "definition": <见 2.1> } },
  { "name": "wait",  "description": <见第四节>, "parameters": <见第四节> }
]
`````
`shell_command` / `exec_command` / `write_stdin` **不是工具条目**，它们的文档在 `exec` 那根 `description` 字符串内部，运行时则挂在 V8 的 `tools` 全局对象上。

常量：`PUBLIC_TOOL_NAME = "exec"`、`WAIT_TOOL_NAME = "wait"`（`code-mode-protocol/src/lib.rs`）。

---

## 二、`exec` 条目

### 2.1 `format.definition`（lark 语法，逐字）

类型 `ToolSpec::Freeform`，序列化只有 `name` / `description` / `format` 三个字段，**没有 `parameters`**。

`````lark
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`````
来源：`core/src/tools/code_mode/execute_spec.rs` 的 `CODE_MODE_FREEFORM_GRAMMAR`。

### 2.2 `description` 的拼装算法

`build_exec_tool_description(enabled_tools, deferred_tools, namespace_descriptions, default_exec_yield_time_ms, code_mode_only)`（`code-mode-protocol/src/description.rs:252`）按顺序拼接，各段之间用**空行**（`\n\n`）连接：

1. `EXEC_DESCRIPTION_TEMPLATE`，其中字面量 `Defaults to 10000 ms.` 被替换为 `Defaults to {default_exec_yield_time_ms} ms.`
2. 若 `deferred_tools` 非空 → 追加 `DEFERRED_NESTED_TOOLS_GUIDANCE`
3. **若 `code_mode_only == false`，到此为止返回**
4. 若任一工具的 output_schema 是 MCP 结构化内容 → 追加 `"Shared MCP Types:\n```ts\n" + MCP_TYPESCRIPT_PREAMBLE + "\n```"`
5. 若 `enabled_tools` 非空 → 追加嵌套工具参考（见 2.6），各工具小节之间同样用空行连接

### 2.3 `EXEC_DESCRIPTION_TEMPLATE`（逐字，3374 字符）

`````
Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
- All nested tools are available on the global `tools` object, for example `await tools.exec_command(...)`. Tool names are exposed as normalized JavaScript identifiers, for example `await tools.mcp__ologs__get_profile(...)`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.
- `yield_time_ms` asks `exec` to yield early if the script is still running. Defaults to 10000 ms.
- `max_output_tokens` sets the token budget for direct `exec` results. Defaults to 10000 tokens.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- `exit()`: Immediately ends the current script successfully (like an early return from the top level).
- `text(value: string | number | boolean | undefined | null)`: Appends a text item. Non-string values are stringified with `JSON.stringify(...)` when possible.
- `image(imageUrlOrItem: string | { image_url: string; detail?: "auto" | "low" | "high" | "original" | null } | ImageContent, detail?: "auto" | "low" | "high" | "original" | null)`: Appends an image item. `image_url` should be a base64-encoded `data:` URL. To forward an MCP tool image, pass an individual `ImageContent` block from `result.content`, for example `image(result.content[0])`. MCP image blocks may request detail with `_meta: { "codex/imageDetail": "original" }`. When provided, the second `detail` argument overrides any detail embedded in the first argument.
- `audio(audioUrlOrItem: string | { audio_url: string } | AudioContent)`: Appends an audio item. `audio_url` should be a base64-encoded `data:` URL. To forward an MCP tool audio block, pass an individual `AudioContent` block from `result.content`, for example `audio(result.content[0])`.
- `generatedImage(result: { image_url: string; output_hint?: string })`: Appends an image-generation result and its optional output hint. HTTP(S) URLs are not supported.
- `store(key: string, value: any)`: stores a serializable value under a string key for later `exec` calls in the same session.
- `load(key: string)`: returns the stored value for a string key, or `undefined` if it is missing.
- `notify(value: string | number | boolean | undefined | null)`: immediately injects an extra `custom_tool_call_output` for the current `exec` call. Values are stringified like `text(...)`.
- `setTimeout(callback: () => void, delayMs?: number)`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep `exec` alive by themselves; await an explicit promise if you need to wait for one.
- `clearTimeout(timeoutId?: number)`: cancels a timeout created by `setTimeout`.
- `ALL_TOOLS`: metadata for the enabled nested tools as `{ name, description }` entries.
- `yield_control()`: yields the accumulated output to the model immediately while the script keeps running.
`````
### 2.4 `DEFERRED_NESTED_TOOLS_GUIDANCE`（逐字）

`````
Some deferred nested tools may be omitted from this description. They are still available on the global `tools` object and listed in `ALL_TOOLS`.
To find one, filter `ALL_TOOLS` by `name` and `description`.
`````
### 2.5 `MCP_TYPESCRIPT_PREAMBLE`（逐字）

仅当启用的工具里存在 MCP 结构化输出时才插入，插入时被包在 ```` ```ts ```` 围栏内，前面加一行 `Shared MCP Types:`。

`````ts
type Role = "user" | "assistant";
type MetaObject = Record<string, unknown>;
type Annotations = {
  audience?: Role[];
  priority?: number;
  lastModified?: string;
};
type Icon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
};
type TextResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  text: string;
};
type BlobResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  blob: string;
};
type TextContent = {
  type: "text";
  text: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type AudioContent = {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ResourceLink = {
  icons?: Icon[];
  name: string;
  title?: string;
  uri: string;
  description?: string;
  mimeType?: string;
  annotations?: Annotations;
  size?: number;
  _meta?: MetaObject;
  type: "resource_link";
};
type EmbeddedResource = {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;
type CallToolResult<TStructured = { [key: string]: unknown }> = {
  _meta?: MetaObject;
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: TStructured;
  [key: string]: unknown;
};
`````
### 2.6 嵌套工具小节的渲染模板

每个启用的嵌套工具渲染成一节。标题（`render_tool_heading`）：

`````
### `{global_name}`                    // global_name == raw_name 时
### `{global_name}` (`{raw_name}`)     // 两者不同时
`````
正文（`render_code_mode_sample`，`description.rs:379`）——格式化字符串本身是：

`````
{description}

exec tool declaration:
```ts
declare const tools: { {tool_name}({input_name}: {input_type}): Promise<{output_type}>; };
```
`````
其中：

| 字段 | 取值规则 |
|---|---|
| `tool_name` | `normalize_code_mode_identifier(name)` |
| `input_name` | Function 类工具为 `args`；Freeform 类为 `input` |
| `input_type` | Function：`render_json_schema_to_typescript(input_schema)`，无 schema 时为 `unknown`；Freeform：固定 `string` |
| `output_type` | MCP 结构化输出 → `CallToolResult<...>`（内层为 `unknown` 时退化为 `CallToolResult`）；否则 `render_json_schema_to_typescript(output_schema)`，无 schema 时为 `unknown` |

若某个 namespace 有描述且与上一节不同，会在该工具小节前插入一次 `## {namespace_name}\n{namespace_description}`（同一 namespace 只插一次）。

**这一步是全文唯一由代码计算、无法逐字给出的部分**：JSON Schema 经 `render_json_schema_to_typescript`（`description.rs:449`）转成 TypeScript 类型文本。下一节给出这三个工具的 schema 素材，可据此推出其 TS 形态。

---

## 二点五、嵌套面里到底有哪三个：shell type 解析链路

**关键前提：`shell_command` 与 `exec_command` / `write_stdin` 互斥，不会同时出现在嵌套面里。**具体是哪一边，由下面这条链路决定，**与 `models.json` 里的 `shell_type` 关系不大**。

`shell_type_for_model_and_features`（`tools/src/tool_config.rs:81`）：

`````rust
match unified_exec_feature_mode {
    Disabled          => shell_command_type,   // 唯一读 model_info.shell_type 的分支
    Direct | ZshFork  => if conpty_supported() { UnifiedExec } else { ShellCommand },
}                                              // 上面这条完全无视 model_info.shell_type
`````
`unified_exec_feature_mode_for_features`（同文件 `:67`）：`ShellTool` 或 `UnifiedExec` 任一关闭 → `Disabled`；`ShellZshFork` 开而 `UnifiedExecZshFork` 关 → `Disabled`；否则 → `Direct`。

特性默认值（`features/src/lib.rs`）：

| Feature | key | default_enabled |
|---|---|---|
| `UnifiedExec` | `unified_exec` | `!cfg!(windows)` |
| `ShellZshFork` | `shell_zsh_fork` | `false` |
| `UnifiedExecZshFork` | `unified_exec_zsh_fork` | `false` |

`conpty_supported()` 在非 Windows 上恒为 `true`（`utils/pty/src/pty.rs:47`，注释原文 "non-Windows always true"）。

**默认配置下的结果：**

| 平台 | 解析结果 | 嵌套面里有 | 没有 |
|---|---|---|---|
| macOS / Linux | `UnifiedExec` | `exec_command`、`write_stdin` | `shell_command`（以 `Hidden` 注册，仅供内部 dispatch） |
| Windows | `ShellCommand` | `shell_command` | `exec_command`、`write_stdin` |

注册逻辑见 `core/src/tools/spec_plan.rs` 的 `match shell_type_for_model_and_features(...)`。`ToolExposure::Hidden` 的 `is_available_in_code_mode()` 返回 `false`（`tools/src/tool_executor.rs:44`），所以 UnifiedExec 分支下的 `shell_command` 既不在工具列表也不在嵌套面。

**所有模型（含 `gpt-5.6-sol` / `terra` / `luna`）在 `models.json` 里的 `shell_type` 都是 `shell_command`**——该字段只在 unified exec 特性被显式关闭时才起作用。

---

## 三、三个命令类嵌套工具的逐字素材

来源：`core/src/tools/handlers/shell_spec.rs`。**注意：按第二点五节，这三个不会同时出现——macOS/Linux 默认只有 3.1 与 3.2，Windows 默认只有 3.3。**参数集合随 `CommandToolOptions`（`allow_login_shell`、`exec_permission_approvals_enabled`）和 `include_environment_id` / `include_shell_parameter` 变化，下表标注了条件项。`properties` 是 `BTreeMap`，故 JSON 中按键名字典序排列。

### 3.1 `exec_command`（UnifiedExec 分支：macOS / Linux 默认）

**工具描述（非 Windows，逐字）**

`````
Runs a command in a PTY, returning output or a session ID for ongoing interaction.
`````
Windows 上则为该句 + `\n\n` + `windows_shell_guidance()`（见 3.4）。

**参数描述（逐字）**

| 参数 | 类型 | description |
|---|---|---|
| `cmd` | string | Shell command to execute. |
| `workdir` | string | Working directory for the command. Defaults to the turn cwd. |
| `tty` | boolean | True allocates a PTY for the command; false or omitted uses plain pipes. |
| `yield_time_ms` | number | 非 Windows：Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms. |
| `yield_time_ms` | number | Windows：Maximum time to wait before returning a session ID for a still-running command. Commands that finish sooner return immediately. For ordinary commands, omit this parameter to use the 10000 ms default. Effective range on Windows is 10000-30000 ms. |
| `max_output_tokens` | number | Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy. |
| `shell` | string | 条件项 `include_shell_parameter`。Shell binary to launch. Defaults to the user's default shell. |
| `login` | boolean | 条件项 `allow_login_shell`。True runs the shell with -l/-i semantics; false disables them. Defaults to true. |
| `environment_id` | string | 条件项 `include_environment_id`。Environment id from <environment_context>. Omit to use the primary environment. |

必填：`cmd`。`additionalProperties: false`。另附审批参数（见 3.5）。

**`output_schema`（逐字，`unified_exec_output_schema()`）**

`````json
{
  "type": "object",
  "properties": {
    "chunk_id":             { "type": "string", "description": "Chunk identifier included when the response reports one." },
    "wall_time_seconds":    { "type": "number", "description": "Elapsed wall time spent waiting for output in seconds." },
    "exit_code":            { "type": "number", "description": "Process exit code when the command finished during this call." },
    "session_id":           { "type": "number", "description": "Session identifier to pass to write_stdin when the process is still running." },
    "original_token_count": { "type": "number", "description": "Approximate token count before output truncation." },
    "output":               { "type": "string", "description": "Command output text, possibly truncated." }
  },
  "required": ["wall_time_seconds", "output"],
  "additionalProperties": false
}
`````
### 3.2 `write_stdin`（UnifiedExec 分支：macOS / Linux 默认）

**工具描述（逐字）**

`````
Writes characters to an existing unified exec session and returns recent output.
`````
**参数描述（逐字）**

| 参数 | 类型 | description |
|---|---|---|
| `session_id` | number | Identifier of the running unified exec session. |
| `chars` | string | Bytes to write to stdin. Defaults to empty, which polls without writing. |
| `yield_time_ms` | number | Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default. |
| `max_output_tokens` | number | Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy. |

必填：`session_id`。`additionalProperties: false`。`output_schema` 与 `exec_command` 相同。

### 3.3 `shell_command`（ShellCommand 分支：Windows 默认）

**工具描述（非 Windows，逐字）**

`````
Runs a shell command and returns its output.
- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary.
`````
**工具描述（Windows，逐字）**——末尾的 `{}` 由 `windows_shell_guidance()` 填入；`{{` `}}` 是 Rust 格式化转义，实际输出为单层花括号：

`````
Runs a Powershell command (Windows) and returns its output.

Examples of valid command strings:

- ls -a (show hidden): "Get-ChildItem -Force"
- recursive find by name: "Get-ChildItem -Recurse -Filter *.py"
- recursive grep: "Get-ChildItem -Path C:\\myrepo -Recurse | Select-String -Pattern 'TODO' -CaseSensitive"
- ps aux | grep python: "Get-Process | Where-Object {{ $_.ProcessName -like '*python*' }}"
- setting an env var: "$env:FOO='bar'; echo $env:FOO"
- running an inline Python script: "@'\\nprint('Hello, world!')\\n'@ | python -"

{}
`````
**参数描述（逐字）**

| 参数 | 类型 | description |
|---|---|---|
| `command` | string | Shell script to run in the user's default shell. |
| `workdir` | string | Working directory for the command. Defaults to the turn cwd. |
| `timeout_ms` | number | Maximum command runtime. Defaults to 10000 ms. |
| `login` | boolean | 条件项 `allow_login_shell`。True runs with login shell semantics; false disables them. Defaults to true. |

必填：`command`。`output_schema`：**无**。

### 3.4 `windows_shell_guidance()`（逐字）

`````
Windows safety rules:
- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to `cmd /c`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as `Remove-Item` / `Move-Item` with `-LiteralPath`, and avoid string-built shell commands for file operations.
- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.
- When using `Start-Process` to launch a background helper or service, pass `-WindowStyle Hidden` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.
`````
### 3.5 审批参数（`create_approval_parameters`，逐字）

| 参数 | 说明 |
|---|---|
| `sandbox_permissions` | 枚举。`exec_permission_approvals_enabled` 为真时取值 `["use_default", "with_additional_permissions", "require_escalated"]`，否则 `["use_default", "require_escalated"]`。<br>描述（启用时）：Per-command sandbox override. Defaults to `use_default`; use `with_additional_permissions` with `additional_permissions`, or `require_escalated` for unsandboxed execution.<br>描述（未启用时）：Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution. |
| `justification` | User-facing approval question for `require_escalated`; omit otherwise. |
| `prefix_rule` | Reusable approval prefix for `cmd`, only with `sandbox_permissions: "require_escalated"`; for example ["git", "pull"]. |
| `additional_permissions` | Sandboxed filesystem or network access for this command; only with `sandbox_permissions: "with_additional_permissions"`. |

`additional_permissions` 内含：网络 `True requests network access; false or omitted requests none.`；读路径 `Absolute paths to grant read access; omit when none are needed.`；写路径 `Absolute paths to grant write access; omit when none are needed.`。

---

## 四、`wait` 条目（完整）

与 `exec` 不同，`wait` 是**普通的 function tool**，有完整 JSON schema。来源：`core/src/tools/code_mode/wait_spec.rs`。

**description** = 下面这句 + 换行 + `WAIT_DESCRIPTION_TEMPLATE`（`{}` 处填入 `exec`）：

`````
Waits on a yielded `exec` cell and returns new output or completion.
`````
**`WAIT_DESCRIPTION_TEMPLATE`（逐字）**

`````
- Use `wait` only after `exec` returns `Script running with cell ID ...`.
- `cell_id` identifies the running `exec` cell to resume.
- `yield_time_ms` controls how long to wait for more output before yielding again. Defaults to 10000 ms.
- `max_tokens` limits how much new output this wait call returns. Defaults to 10000 tokens.
- `terminate: true` stops the running cell; false or omitted waits for output.
- `wait` returns only the new output since the last yield, or the final completion or termination result for that cell.
- If the cell is still running, `wait` may yield again with the same `cell_id`.
- If the cell has already finished, `wait` returns the completed result and closes the cell.
`````
**parameters（逐字）**

`````json
{
  "type": "object",
  "properties": {
    "cell_id":       { "type": "string",  "description": "Identifier of the running exec cell." },
    "yield_time_ms": { "type": "number",  "description": "Wait before yielding more output. Defaults to 10000 ms." },
    "max_tokens":    { "type": "number",  "description": "Output token budget for this wait call. Defaults to 10000 tokens." },
    "terminate":     { "type": "boolean", "description": "True stops the running exec cell; false or omitted waits for output." }
  },
  "required": ["cell_id"],
  "additionalProperties": false
}
`````
`strict: false`，`output_schema: None`。

---

## 五、`exec` 伪指令的校验规则

`parse_exec_source`（`code-mode-protocol/src/description.rs:167` 起）：

- 输入必须是非空的原始 JavaScript 源码
- 首行可选伪指令，前缀常量 `CODE_MODE_PRAGMA_PREFIX = "// @exec:"`
- 伪指令必须是 JSON **对象**
- **只接受 `yield_time_ms` 和 `max_output_tokens` 两个键**，出现其他键即报错并点名该键
- 两值必须是非负 JS 安全整数（上限 `MAX_JS_SAFE_INTEGER = 2^53 - 1`）
- 伪指令之后必须还有 JavaScript 源码

错误信息（逐字）：

`````
exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.
exec pragma must be followed by JavaScript source on subsequent lines
exec pragma must be a JSON object with supported fields `yield_time_ms` and `max_output_tokens`
exec pragma must be valid JSON with supported fields `yield_time_ms` and `max_output_tokens`: {err}
exec pragma only supports `yield_time_ms` and `max_output_tokens`; got `{key}`
exec pragma fields `yield_time_ms` and `max_output_tokens` must be non-negative safe integers: {err}
exec pragma field `yield_time_ms` must be a non-negative safe integer
`````
---

## 六、V8 里的全局对象（供对照）

这些不在上下文里，但决定了模型写出的代码能调什么。来源：`code-mode-runtime/src/runtime/globals.rs`。

**删除的全局**：`console`、`Atomics`、`SharedArrayBuffer`、`WebAssembly`

**安装的全局**：`tools`、`ALL_TOOLS`、`setTimeout`、`clearTimeout`、`text`、`image`、`audio`、`generatedImage`、`store`、`load`、`notify`、`yield_control`、`exit`

`text()` 的实现路径：`text_callback` 序列化入参 → 发出 `RuntimeEvent::ContentItem(FunctionCallOutputContentItem::InputText)` → 经 `core/src/tools/code_mode/response_adapter.rs` 汇总 → 成为模型收到的 tool result 内容块。**没有调用过 `text()` 的 exec，模型收到空结果。**

---

## 七、源码索引

| 内容 | 文件 |
|---|---|
| `exec` / `wait` 工具名常量 | `codex-rs/code-mode-protocol/src/lib.rs` |
| description 模板与拼装 | `codex-rs/code-mode-protocol/src/description.rs` |
| JSON Schema → TypeScript | `description.rs:449` `render_json_schema_to_typescript` |
| lark 语法与 exec ToolSpec | `codex-rs/core/src/tools/code_mode/execute_spec.rs` |
| `wait` ToolSpec | `codex-rs/core/src/tools/code_mode/wait_spec.rs` |
| 三个命令类工具的 spec | `codex-rs/core/src/tools/handlers/shell_spec.rs` |
| 嵌套工具从模型列表中隐藏 | `codex-rs/core/src/tools/spec_plan.rs` `is_hidden_by_code_mode_only` |
| V8 全局注入 | `codex-rs/code-mode-runtime/src/runtime/globals.rs` |
| `text()` 等回调实现 | `codex-rs/code-mode-runtime/src/runtime/callbacks.rs` |
| shell type 解析与特性默认值 | `codex-rs/tools/src/tool_config.rs`、`codex-rs/features/src/lib.rs` |
| 模型与 tool_mode 绑定 | `codex-rs/models-manager/models.json`、`codex-rs/protocol/src/openai_models.rs:445` |


提取方式：本文所有标注「逐字」的内容，由脚本从上述 Rust 源码的字符串字面量中直接提取（Rust 转义已还原），未经人工转录。
