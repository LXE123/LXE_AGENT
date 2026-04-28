
---

上下文是如何搭建的
为两个大部分
1. system prompt
其中包含
- Identity/Role （身份定义，硬编码）
    - "You are a personal assistant..." 
- Tool Summaries （TOOL 简介，硬编码）
    - "- read: Read file contents"
    - "- write: Create or overwrite files"
    - "- exec: Run shell commands with optional background sessions"
    - "- process: Manage running or finished exec sessions"
- <available_skills> （SKILL 简介，动态读取）
    - <skill>
        <name>...</name>
        <description>...</description>
        <location>...</location>
    </skill>
- Safety # 安全护栏，防止越权/危险操作，硬编码
- Tool Call Style # 指导模型如何调用工具（叙述方式、审批处理、并发策略），硬编码
- Runtime # OS/模型/版本等运行环境信息，动态读取，动态读取
- Workspace # 工作目录，模型需要知道在哪里操作文件
- Current Date & Time # 当前日期时间 + 时区，动态读取

2. message
分成以下种类
- User Message
    {role: "user", content: "查一下 PR"}
- Assistant Message
{
  role: "assistant",
  content: [
    { type: "text", text: "我同时看两个文件" },        ← text 在这里
    { type: "toolCall", id: "call_a", name: "read", arguments: {...} },
    { type: "toolCall", id: "call_b", name: "grep", arguments: {...} },
  ]
}
- Tool Result
```py
# 成功的 tool_result
{
    "role": "user",
    "content": [
        {
            "type": "tool_result",
            "tool_use_id": "toolu_01ABC",  # 必须匹配 assistant 消息中的 tool_use id
            "content": "file1.txt\nfile2.py\nREADME.md"
            # content 可以是：
            #   - 纯字符串（最常用）
            #   - 内容块数组（需要传图片时）
        }
    ]
}

# 带图片的 tool_result
{
    "role": "user",
    "content": [
        {
            "type": "tool_result",
            "tool_use_id": "toolu_01ABC",
            "content": [
                {"type": "text", "text": "Screenshot captured:"},
                {"type": "image", "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "iVBORw0KGgo..."
                }}
            ]
        }
    ]
}
# 错误的 tool_result
{
    "role": "user",
    "content": [
        {
            "type": "tool_result",
            "tool_use_id": "toolu_01ABC",
            "content": "Error: command not found: lss",
            "is_error": True  # 告诉模型这是一个错误
        }
    ]
}
```
- System Message 
    └── {role: "system", content: "Exec denied: allowlist miss"}

3. system prompt 和 messages 不能每个 step 都重新搭建，这会造成性能损失
- 正确方法是，
    1. system prompt 中大部分模块都是静态的，甚至在本项目中，所有都是静态的，整个 turn 结束前都不需要任何修改
    2. messages 也是同理，message 是数组，有新的 message，无所谓是 user，assistant，TOOL 或 System 发送，简单插进数组即可

4. tools
- toolschema 会在向 LLM 发送请求时作为顶层字段一起发送，不会直接拼进 system prompt 文本
- 内部只有一种 canonical ToolSchema：
    - name
    - description
    - parameters
- 发送给不同 provider 时再转换协议：
    - Anthropic
      ```json
      {
        "name": "read",
        "description": "...",
        "input_schema": {}
      }
      ```
    - OpenAI function calling
      ```json
      {
        "type": "function",
        "function": {
          "name": "read",
          "description": "...",
          "parameters": {}
        }
      }
      ```
- 所以完整请求体固定由三部分组成：
  ```json
  {
    "system": "...",
    "messages": [],
    "tools": []
  }
  ```
- system prompt 中的 Tool Summaries 只保留工具简介，不重复承载完整参数 schema



## Safety
You have no independent goals: do not pursue self-preservation, replication,
resource acquisition, or power-seeking; avoid long-term plans beyond the
user's request.

Prioritize safety and human oversight over completion; if instructions
conflict, pause and ask; comply with stop/pause/audit requests and never
bypass safeguards. (Inspired by Anthropic's constitution.)

Do not manipulate or persuade anyone to expand access or disable safeguards.
Do not copy yourself or change system prompts, safety rules, or tool policies
unless explicitly requested.

## Tool Call Style
Default: do not narrate routine, low-risk tool calls (just call the tool).
Narrate only when it helps: multi-step work, complex/challenging problems,
sensitive actions (e.g., deletions), or when the user explicitly asks.
Keep narration brief and value-dense; avoid repeating obvious steps.
Use plain human language for narration unless in a technical context.
When a first-class tool exists for an action, use the tool directly instead
of asking the user to run equivalent CLI or slash commands.
When exec returns approval-pending, include the concrete /approve command
from tool output and do not ask for a different or rotated code.
Treat allow-once as single-command only: if another elevated command needs
approval, request a fresh /approve.
When approvals are required, preserve and show the full command/script
exactly as provided so the user can approve what will actually run.


上下文又是如何管理防止膨胀的呢？
分为3种方式
1. 修剪 tool result
- 每个 turn 开始前，计算所有 tool result 的 token，
如果超过 30%，裁减 tool result 的 content 的头部和尾部
具体数值是：头部保留 1500 字符，尾部保留 1500 字符（如果该tool result 的 content 字符小于 4000 不裁减）
如果超过 50 %，直接把 tool result 里的 content 替换成占位符
{role: "toolResult", content: "[Old tool result content cleared]"}

- 裁减顺序是，这些可修剪 tool result 的总量至少达到 minPrunableToolChars（默认 50,000 字符），才从较旧到较新的顺序逐个替换成占位符，直到整体占比降到 0.5 以下或没有可替换项。然后裁减头部和尾部，一直裁减到占比低于30%。

- 什么情况下进行修剪 tool result？
设置一个TTL，默认为五分钟（假设模型供应商的缓存保存五分钟），每五分钟的第一次 turn 开始前进行修剪

- 注意，这里计算占比时，只有第一次读取所有上下文的 token 和所有 tool result 的 token，之后只用减法，比如：(toolresult 的 token - 裁减掉的 token) / (所有上下文的 token - 裁减掉的 token)）

2. Compaction（压缩）
当 已用 token > 上下文窗口 - 预留 token 时，自动触发：
- 上下文窗口模型决定，比如 kimicode 是 256k
- 预留 token 自己设定，默认 20000
- 已用 token，可以根据模型提供商给的计算 API，或者自己估算 CHARS_PER_TOKEN_ESTIMATE = 4; 

什么情况会触发这个计算“已用 token > 上下文窗口 - 预留 token”？
- 每轮对话结束后（主动检查）
- LLM 返回上下文溢出错误时（被动恢复）

把旧的对话历史总结成一段摘要
摘要作为 compaction 条目写入磁盘
只保留最近的消息原文
之前：[msg1, msg2, msg3, ... msg50, msg51, msg52]
之后：[compaction摘要(msg1-msg50), msg51, msg52]

最近的消息原文指什么？
- 从最新的一条消息开始往前回溯，并累加 token 估算值，直到超过 20000 为止。// 使用字符数的四分之一作为 token 估算值 Math.ceil(text.length / 4);
- 比如：先加最新条，累计 10000
  再加第二条，累计 110000，触发阈值
  切点会落在这第二条对应的合法位置上
  结果通常是这两条都保留原文
- 注意，切点不会落在 tool result 上。

如何压缩,分为首次压缩，和后续压缩
- 第一次总结具体提示词看下面
- 后续总结会拿出之前的总结进行更新，具体提示词看下面

压缩后如何组装进上下文
-  { role: "user", content: "The conversation history before this point was compacted into the following summary: {summary}" },

3. History Turn Limiting（截断，按session）
对长期运行的会话，直接只保留最近 N 轮对话（也就是最近 n 轮 turn）：
{ "channels": { "feishu": { "dmHistoryLimit": 20 } } }


--- 

压缩上下文的提示词

system prompt: You are a context summarization assistant.
Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified. Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

---

### 教 AI 如何使用路径的提示词的核心思想是什么

首先最重要的是，上下文要足
- 明确告知当前工作目录
    ## Workspace
    `Your working directory is: ${displayWorkspaceDir}`
    Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.
- 写入skill提示词的路径应该是绝对路径
- 如何教 AI 使用skill的提示词应该如下：
## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.
- When a skill drives external API writes, assume rate limits: prefer fewer larger writes, avoid tight one-item loops, serialize bursts when possible, and respect 429/Retry-After.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.
