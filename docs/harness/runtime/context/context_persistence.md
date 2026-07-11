# Context Persistence

状态：Current

## 目的

Context persistence 让进程重启、turn 中断和 summary compaction 后仍能重建模型实际看见的 history，同时保留 append-only 审计轨迹。它区分原始 transcript 与当前 model-visible replacement，不用整文件重写来“压缩历史”。

事实来源是 [`packages/runtime/src/storage.ts`](/packages/runtime/src/storage.ts)。

## 存储组成

默认状态目录包含：

- `local_agent.sqlite3`：session、route、pending event、usage 和 Dashboard 查询。
- `session_transcripts/<session>.jsonl`：append-only message/checkpoint 日志。
- `sessions.json`：平台 source 到 session id 的 binding，由 Gateway 管理。

SQLite schema 在 store start 时初始化。JSONL 与 SQLite 承担不同职责：transcript 保存模型历史事件，SQLite 保存可查询的结构化状态。

## JSONL 事件

Runtime 使用两类核心记录：

- message append：user、steering、assistant 或 tool-result message，带 reason/时间等 metadata。
- replacement/compaction checkpoint：声明从某个位置开始，当前 model view 应替换为新的 messages。

旧行永远不修改。Replay 按顺序读取事件，并应用最新有效 replacement，得到当前 provider history。这样原始 tool output 仍可审计，而长期 model view 可以变短。

## 写入时机

- 当前 user message 在第一次 provider request 前写入。
- steering 被消费时立即写入。
- provider response 在 tool dispatch 前写入。
- tool result 在每组调用闭合后写入。
- 成功 compaction 在验证 token 下降后写 replacement。
- final/post-turn maintenance 可以追加 checkpoint，但不回写旧事件。

写入顺序必须与模型可见顺序一致。进程在工具中间退出时，replay sanitizer 会补缺失 result stub，不会重复执行工具。

## Replay cache

Store 以 transcript 文件 size/mtime 组成 signature：

- 首次 load 解析 JSONL 并缓存 view。
- 进程内 append/replacement 同步更新 cache。
- 外部 append、truncate、delete 或 replace 改变 signature，下一次 load 自动 replay。
- cache 只缓存可重建数据，不是持久化单一事实源。

这个路径避免 emitter、Dashboard 或 turn 热路径反复解析完整 transcript。

## Image 与敏感数据

写入 transcript 前，已由模型处理的 base64 image 替换为文本占位。Provider auth、cookie、local secret 和 wire header 从不写入 context。redacted thinking opaque data可以保存在 canonical message，但日志、summary 和展示必须遮蔽。

## Session 与 response route

Session record 保存 source、state 和时间 metadata，不复制完整 transcript。response route 单独存储 platform/conversation/message/delivery handle，使 outbox failure 不影响 model history。

Tool state patch 只合并受控 JSON object。后台任务先写 pending event，下一 heartbeat turn pop 后再进入 context，避免子进程直接修改 transcript 或发送平台消息。

## Compaction checkpoint

Replacement 写入前必须满足：

1. summary 非空。
2. canonical closure 有效。
3. 新 estimate 小于原 estimate。
4. signal 未 aborted。

失败时不写任何 replacement。Post-turn checkpoint 即使失败也不回滚已完成 turn。

## Legacy 兼容

Replay 可以读取旧 message envelope、tool role 和已有 replacement/compaction JSONL，并归一为当前 canonical shape。兼容逻辑只用于读取旧用户数据；新写入始终使用当前事件格式。

## 故障处理

- 单行 JSON 损坏必须报告可定位错误，不能静默丢弃后续 transcript。
- SQLite transaction 失败不应留下半写 route/state。
- 外部文件变化使 cache 失效，而不是继续返回陈旧历史。
- Turn usage 使用幂等 guard，异常路径最多记录一次。

## 验证

Storage tests 覆盖 schema bootstrap、append/replay、replacement、cache invalidation、session/route/pending events、usage 查询和 Unicode 路径。任何 JSONL 形态变化都需要向后兼容 fixture。
