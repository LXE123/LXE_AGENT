# Context 持久化

状态：Current

## 先说结论

Context 持久化解决两个问题：进程重启后还能继续对话，以及历史太长时能缩短模型看到的内容。Runtime 不会重写旧消息，而是在 Transcript v2 中持续追加事件。

普通消息写一次；压缩、修复和重置通过最小 `context_patch` 改变“当前模型视图”。这样既能保留完整审计轨迹，也能让下一次模型请求使用更短的上下文。

数据库和文件的完整分工见 [本地状态与数据库](../../../database/local_agent.md)。本篇只解释 transcript 如何写入和 replay。

## Transcript v2 事件

每个 session 对应一个 `session_transcripts/<session>.jsonl` 文件。主要事件只有四类：

| 事件 | 作用 |
| --- | --- |
| `transcript_header` | 标记 transcript 版本和 session |
| `message` | 保存 user、assistant 或 tool canonical message |
| `turn_context` | 记录本轮实际 provider、model、effort 和 context window |
| `context_patch` | 对当前模型视图做最小删除和插入 |

一次压缩可能追加这样的事件：

```json
{
  "kind": "context_patch",
  "start": 4,
  "delete_count": 18,
  "insert_messages": [
    {"role": "user", "content": "较早对话已压缩为摘要……"}
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
- tool result 在执行后写入，并保证 tool call 闭合。
- compaction 只有在摘要有效、上下文确实变短且没有取消时才写 `context_patch`。
- post-turn maintenance 可以继续治理长期历史；失败只记 warning，不撤销已经发送的最终答案。

进程如果在工具执行中间退出，replay sanitizer 会补明确的 unavailable result，使历史保持可读，但不会自动重跑工具。

## Replay cache 与索引

Runtime 使用 transcript 的文件大小和修改时间判断缓存是否仍有效。进程内 append 会同步更新缓存；外部追加、截断、删除或替换文件后，下一次读取会重新 replay。

SQLite 中的 transcript 状态和 Dashboard 分页区间都是可重建索引，不是会话正文的第二份真相。缓存或索引损坏时，应从 JSONL 重建，而不是反过来覆盖 transcript。

## 图片与敏感数据

图片第一次交给模型后，持久化时会把 base64 数据换成文本占位，保留“这里曾有图片”的语义，避免后续 turn 反复携带大块二进制。

Provider 密钥、cookie、authorization header 和本地 secret 不进入 Context。需要兼容的 opaque thinking 数据也不能出现在 summary、日志或 Dashboard 正文中。

## 旧数据兼容

Runtime 只直接读取 Transcript v2。带 `replacement_history` 的 v1 整段替换事件、v1 工具块命名（`tool_use`/`tool_use_id`）以及 transcript 机制之前的 `session_messages/*.jsonl`，在加载时都会抛出错误并提示先用 `scripts/migrate-transcripts-v2.ts` 迁移。当前版本的新写入一律使用 Transcript v2 的最小 `context_patch`。

## 故障处理

- 已完整写入但格式错误的 JSONL 行必须报出可定位错误，不能静默跳过后续历史。
- 进程崩溃留下的未换行尾部可以忽略，最后一个完整事件仍应正常 replay。
- 越界或结构错误的 `context_patch` 必须失败，不能猜测修复。
- SQLite 事务失败不能留下半条 session、route 或 usage 更新。
- summary 失败、为空或没有降低 token 时，不写 patch，原模型视图保持不变。

实现事实来源是 [Transcript v2](/packages/agent/runtime/src/state/transcript.ts) 和 [Runtime storage](/packages/agent/runtime/src/state/storage.ts)。
