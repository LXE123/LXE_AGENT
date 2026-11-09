# Context 持久化

## 先说结论

Context 持久化解决两个问题：进程重启后还能继续对话，以及历史太长时能缩短模型看到的内容。Runtime 不会重写旧消息，而是在 Transcript v3 中持续追加事件。

普通消息写一次；压缩、修复和重置通过最小 `context_patch` 改变“当前模型视图”。这样既能保留完整审计轨迹，也能让下一次模型请求使用更短的上下文。

数据库和文件的完整分工见 [本地数据与存储](../../../storage/README.md)。本篇只解释 transcript 如何写入和 replay。

## Transcript v3 事件

每个 session 对应数据目录下的 `db/session_transcripts/<session>.jsonl` 文件。与模型历史及选择相关的主要事件如下；其他审计事件以 transcript 契约为准：

| 事件 | 作用 |
| --- | --- |
| `transcript_header` | 标记 transcript 版本和 session |
| `message` | 保存统一消息，包括用户输入、模型响应与工具结果 |
| `model_selection` | 保存会话模型选择及版本，详见 [会话模型](../session-models.md) |
| `turn_end` | 记录轮尾节点及结果（完成、手动停止或错误等终态），供界面选择分叉位置 |
| `turn_context` | 记录本轮实际 provider、model、effort 和 context window |
| `codemode_store` | 保存单次成功脚本的 `set` 和 `delete`。按分支顺序恢复脚本数据，模型消息回放跳过此记录 |
| `tools_loaded` | 记录一次 `tool_search` 新加载的工具。MCP 工具按服务名和原始工具名定位，续聊和分叉使用当前可用的定义；模型消息回放跳过此记录 |
| `context_patch` | 对当前模型视图做最小删除和插入 |

一次压缩可能追加这样的事件：

```json
{
  "kind": "context_patch",
  "start": 4,
  "delete_count": 18,
  "insert_messages": [
    {"role": "compactionSummary", "summary": "较早对话已压缩为摘要……", "tokensBefore": 220000, "details": {"readFiles": [], "modifiedFiles": []}}
  ],
  "patch_kind": "compaction"
}
```

`start` 和 `delete_count` 指向当前模型视图，不是 JSONL 行号。`insert_messages` 只保存真正变化的部分，不复制整段历史。

## 两种视图

同一份 transcript 会产生两个用途不同的视图：

- **模型 replay**：按顺序读取 `message`，再应用每个 `context_patch`，得到 provider 下一次真正看见的 history。
- **Dashboard 展示**：按原始事件分页，保留历史消息，并在压缩或重置位置插入说明标记；超大的 tool result 只在 Dashboard DTO 中返回有明确字节标记的有界预览，磁盘 transcript 不变。

所以“模型已经不再携带某段原始工具输出”不等于“Dashboard 或磁盘上删除了这段记录”。

## 写入顺序

- 当前 user message 在第一次 provider request 前写入。
- steering 被消费时立即作为独立 user message 写入。
- 完整 assistant response 在 tool dispatch 前写入。
- 流式请求出错或中止时，已收到的非空正文按本次请求的消息 ID 保存为一条助手消息，事件的 `reason` 为 `assistant_partial`，消息的 `stopReason` 为 `error` 或 `aborted`。只有推理或工具参数草稿时不写助手正文。自动重试、续聊和分叉后的模型请求都会跳过这条未完成的回复。
- 每个工具调用的结果单独写入一条 tool message，同批结果按调用顺序写入。
- compaction 只有在摘要有效、上下文确实变短且没有取消时才写 `context_patch`。
- post-turn maintenance 可以继续治理长期历史；失败只记 warning，不撤销已经发送的最终答案。

进程如果在工具执行中间退出，replay sanitizer 会补明确的 unavailable result，使历史保持可读，但不会自动重跑工具。

## Replay cache 与索引

Runtime 使用 transcript 的文件大小和修改时间判断缓存是否仍有效。进程内 append 会同步更新缓存；外部追加、截断、删除或替换文件后，下一次读取会重新 replay。

SQLite 中的 transcript 状态和 Dashboard 分页区间都是可重建索引，不是会话正文的第二份真相。缓存或索引损坏时，应从 JSONL 重建，而不是反过来覆盖 transcript。

## 图片与敏感数据

transcript 保留图片的原始 Base64，完成、取消或重启后仍可回放，不会因模型已经处理过就统一换成占位。即使原文件被覆盖或删除，历史仍可使用已保存的图片。

压缩可能让较早图片不再进入当前模型视图，但原始记录和历史预览仍在。Dashboard 的消息 DTO 不携带整段 Base64；摘要输入与部分供应商请求可以省略或替换图片，这些都是用途各异的投影，不改写原始 transcript。[DeepSeek 图片请求](../../llm/deepseek-images.md)另有上传和预算策略。

对应验证入口：[跨轮与重启保留](../../../../packages/agent/runtime/test/engine/image-retention.test.ts)、[历史图片预览](../../../../packages/agent/runtime/test/state/history-images.test.ts)。

应用不把认证配置注入 Context。Transcript 会保存实际会话内容，不能把它当作已脱敏日志；用户或工具提供的内容仍需遵守敏感数据处理规则。需要兼容的 opaque thinking 数据可留在模型历史中，但不能原样出现在 summary、日志或 Dashboard 正文中。

## 旧数据兼容

首次打开或继续写入 v2 对话时，Runtime 按原顺序为文件头之后的每条事件补上 `id` 和 `parent_id`，首条的父节点为 `null`，并原子替换文件。旧的一批工具结果保留原粒度，已有压缩补丁的位置继续有效。可确认的旧轮尾保存在文件头。旧版 v1 和更早的 `session_messages/*.jsonl` 仍需先运行 `scripts/migrate-transcripts-v2.ts`。

## 在新对话中分叉

从历史轮尾分叉时，agentcli 复制截至该轮终点的完整前缀。新对话有独立的 session ID，文件头的 `fork` 保存直接来源的 `session_id`、`turn_id` 和 `entry_id`。复制的节点保留原 ID，下一条记录以复制的最后一个节点为父节点。新对话从零累计自己的用量。桌面标题栏复制当前会话末尾，包括最后一轮结束后已落盘的上下文更新；当前会话有运行或排队任务时暂时禁用此入口。

手动停止时，模型下一轮可见 `<turn_aborted>` 中断标记。历史中标记为 `stopReason: "aborted"` 或 `"error"` 的助手回复会在组装模型请求时跳过。用于界面展示的 `turn_error` 也不会成为下一轮的助手消息。

## 故障处理

- 已完整写入但格式错误的 JSONL 行必须报出可定位错误，不能静默跳过后续历史。
- 进程崩溃留下的未换行尾部可以忽略，最后一个完整事件仍应正常 replay。
- 越界或结构错误的 `context_patch` 必须失败，不能猜测修复。
- SQLite 事务失败不能留下半条 session、route 或 usage 更新。
- summary 失败、为空或没有降低 token 时，不写 patch，原模型视图保持不变。

实现事实来源是 [Transcript v3](../../../../packages/agent/runtime/src/state/transcript.ts) 和 [Runtime storage](../../../../packages/agent/runtime/src/state/storage.ts)。
