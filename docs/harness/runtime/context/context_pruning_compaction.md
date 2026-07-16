# Context Pruning and Compaction

状态：Current

## 目的

本专题说明 Runtime 如何限制单个 tool result、处理历史 image、在 provider request 前估算预算，并用 summary 缩短 model-visible history。核心原则是：只在能证明安全收缩时写 `context_patch`，失败时保留原始状态并显式终止。

事实来源是 [`packages/agent/runtime/src/engine/context.ts`](/packages/agent/runtime/src/engine/context.ts) 及其测试。

## 默认预算

| 项目 | 默认值 |
| --- | ---: |
| Context window fallback | 256000 token |
| Output reserve | 20000 token |
| Pre-call soft threshold | 90% |
| 最近 raw turn 目标 | 20000 token |
| 单步 tool result 文本 | 10000 token |
| 单 image 估值 | 1600 token |
| Summary 最大尝试 | 2 次 |

实际 context window 来自当前 provider descriptor；fallback 只在 descriptor 不可用时使用。

## Tool result 裁剪

新 tool result 在进入下一 provider request 前执行 block-aware 裁剪：

- 字符串按 UTF-8 bytes 估算，超限时保留首尾并插入裁剪说明。
- block list 中多个 text block 共享一个总预算。
- image block 原样保留给当前 turn，不占文本预算，但单独计 image estimate。
- 非文本结构稳定序列化后计入预算。
- error/success 属性与 tool-use id 保持不变。

裁剪只针对新结果，不在 turn 开始时重写历史 tool result。长期预算由 summary compaction 处理。

## 历史 image aging

Image 第一次进入 provider 时保留 source。持久化或后续历史治理阶段，base64 data 替换为固定文本占位；消息和其它文本不删除。

该策略避免同一图片在每个 turn 重复占用上下文，同时保留“用户曾提供图片”的语义。当前 turn 的新 image 不提前移除。

## 完整请求估算

每个 step 在 provider request 前计算：

```text
estimate(system prompt)
+ estimate(canonical messages)
+ estimate(exposed tool schemas)
+ image estimates
```

Hard limit 为 window 减 reserve。`pre_call` 在 90% 提前尝试摘要，避免等待 provider 拒绝；低于阈值时不做无意义 summary。

## 跨 turn compaction

优先保留最近约 20k token 的完整 turns，把更旧且边界闭合的前缀交给 provider summary。成功后 model view 变为：

```text
compaction summary user message
+ retained recent raw turns
```

Summary prompt 要求保留用户目标、已完成工作、关键路径/ID、错误、决策、未完成项和重新获取被省略结果的方法。encrypted thinking data 只以占位出现。

## Mid-turn checkpoint

如果没有可摘要的旧 turn，但当前 user span 本身过大，ContextPipeline：

1. 逐字保留当前原始 user message。
2. 按 assistant tool-use + 对应 results 的闭合 step 分组。
3. 从末端保留最近约 20k token 的原始步骤。
4. 总结中间较早步骤为 checkpoint user message。

边界不会拆开 tool use/result。当前用户请求、最近执行和后续计划仍保持可恢复。

跨 turn summary 后仍超预算时，可以在“旧 summary + 当前 turn”上继续尝试 mid-turn checkpoint。

## Summary provider 调用

Summary 使用当前 provider，但禁用 tools 和 thinking。普通异常、retryable provider failure 或空 summary 最多尝试两次；abort、明确 non-retryable 错误和 summary 自身 context overflow 不盲目重试。

Summary usage 计入当前 turn input/output/api call，并进入 CardKit metrics 与 usage table。

## 写入门禁

只有全部满足时才写 `context_patch`：

- 选择到闭合、非空的可摘要前缀。
- summary 非空且 canonical。
- 新估算严格小于旧估算。
- 新 view 不超过 hard limit，或至少符合当前 trigger 的成功条件。
- signal 未取消。

否则返回 `compacted=false` 或 failure reason，保留原 messages。

## Overflow recovery

Provider 明确报 context overflow 时，Runtime 用 `trigger="overflow"` 强制尝试 summary，即使本地粗略估算未过 soft threshold。成功后同 step 只允许一次 provider retry；再次 overflow 或无法压缩时走 error outcome。

Overflow recovery 不消耗普通网络 retry budget，也不会通过删除 message、伪造本地 summary 或截断当前用户请求来强行继续。

## Post-turn maintenance

Final reply 后可以再次检查长期预算并写 checkpoint。该阶段异常只记录 warning，不撤销已交付消息或 turn outcome。下一 turn 仍可 replay 原 transcript。

## 明确不存在的策略

- 不按 TTL 删除 history。
- 不按消息数量静默截断。
- 不在 turn 开始时清空历史 tool result。
- 不写本地关键词拼接的伪摘要。
- 不因 summary 失败覆盖原 state。

## 验收场景

测试覆盖 UTF-8 tool result 首尾裁剪、image block、tool schema 预算、跨 turn/mid-turn selection、summary retry、token 未下降、abort、provider overflow、`context_patch` persistence 和 closure repair。
