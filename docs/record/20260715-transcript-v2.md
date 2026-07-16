# Transcript v2 与上下文投影

Status: `Current`

## 决策

- `<data-root>/db/session_transcripts/<session>.jsonl` 是会话上下文的逐 turn 权威历史；源码默认 data root 时对应仓库 `var/db/`。
- SQLite 中的 transcript 文件状态、Dashboard 分页区间以及 session 最新模型信息都是可重建投影。
- 普通消息只写一次；上下文压缩、修复和重置写为最小 `context_patch`，不再追加旧版整段替换事件。
- `turn_context` 记录真实执行时采用的 provider、model、effort、thinking 状态、provider generation 和 context window，不记录任何认证信息。

## 迁移命令

只读分析可以在 Gateway 运行时执行：

```bash
bun run transcript:migrate --dry-run
```

写迁移要求 Gateway 已由操作者停止；命令只检查状态，不会代为启停进程：

```bash
bun run transcript:migrate --migrate
```

写迁移依次执行 SQLite checkpoint 与完整性检查、创建
`var/backups/pre-transcript-v2-20260715/` 备份及 SHA-256 清单、逐文件原子替换、重建 SQLite 投影和最终完整性检查。重复执行不会再次改写已经是 v2 的 transcript。

2026-07-15 对迁移前数据的 dry-run 结果为 17 个文件、28,615,280 bytes；预计迁移后为
5,651,718 bytes（19.75%），模型 replay、Dashboard 展示和 633 条原始消息保持一致。
