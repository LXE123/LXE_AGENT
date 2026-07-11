# Runtime Context

状态：Current

事实来源：[`packages/runtime/src/context.ts`](/packages/runtime/src/context.ts) 与 [`storage.ts`](/packages/runtime/src/storage.ts)。

- [Canonical Message](canonical_message.md)
- [Context Assembly](context_assembly.md)
- [Pruning and Compaction](context_pruning_compaction.md)
- [Context Persistence](context_persistence.md)

上下文预算包含 system prompt、messages、tool schemas 和图片固定估值；生产路径不按消息条数静默裁剪。
