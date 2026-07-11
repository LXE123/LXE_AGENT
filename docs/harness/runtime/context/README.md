# Runtime Context

状态：Current

## 目的

Context subsystem 决定 provider 实际看见哪些 system、message、tool schema 和 image 信息，并保证 replay、steering、tool closure 与 compaction 后仍可继续执行。它不是简单的 prompt 拼接器，而是会影响长期模型视图的状态边界。

事实来源是 [`packages/runtime/src/context.ts`](/packages/runtime/src/context.ts)、[`runtime.ts`](/packages/runtime/src/runtime.ts) 和 [`storage.ts`](/packages/runtime/src/storage.ts)。

## 专题导航

- [Canonical Message](canonical_message.md)：message/block 形态与 closure 修复。
- [Context Assembly](context_assembly.md)：turn/step 组装顺序和完整请求预算。
- [Pruning and Compaction](context_pruning_compaction.md)：tool result、image、summary 与 overflow recovery。
- [Context Persistence](context_persistence.md)：append-only transcript、replacement checkpoint 和 replay cache。

## 请求预算

预算包含：

```text
system prompt
+ canonical messages
+ exposed tool schemas
+ image fixed estimates
```

默认 context window 为 256k token，预留 output 20k；90% soft threshold 提前触发 compaction。单个 image 固定估算 1600 token，单步 tool result 文本预算 10k，最近 raw turn 目标保留约 20k。

实际 context window 优先使用当前 provider descriptor。生产路径不按 message 数量或固定字符数静默删除历史。

## 三个时间点

### Turn 输入

Storage replay canonical history，Runtime append 当前 user message。历史已处理 image 在持久化时已经占位，本轮新 image 仍可见。

### Step 前

ContextPipeline sanitize closure、计算完整预算，并按 `pre_call` 或 `overflow` 触发 summary。tool schemas 每 step 重新捕获，因此 exposure 变化从下一 step 生效。

### Turn 后

post-turn maintenance 在 final delivery 后执行，可以写 replacement checkpoint 或整理长期历史。失败只记录 warning，不撤销已交付答案。

## 核心不变量

1. Canonical history 中 tool use 必须有对应 result。
2. Compaction 只能写新 replacement，不能改写旧 JSONL 行。
3. 摘要失败、为空或未降低 token 时保留原 messages。
4. encrypted thinking data 不进入 summary、日志或平台展示。
5. 当前用户请求在 mid-turn compaction 中逐字保留。
6. Image 只在第一次模型处理时携带原始数据。

## 非目标

Context 不负责 provider-specific payload adaptation、平台 card rendering、session permission 或 tool handler timeout。这些分别属于 provider、Gateway、Router 和 tool runtime。
