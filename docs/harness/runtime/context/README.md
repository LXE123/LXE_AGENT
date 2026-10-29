# Runtime Context

上下文模块决定每次模型请求携带哪些历史、系统提示与工具定义，并在历史过长时压缩模型视图。一次 turn 可以多次组装、估算和压缩上下文；原始记录与当前模型视图的关系由 transcript 管理。

## 专题分工

| 问题 | 主要维护位置 |
| --- | --- |
| 统一消息、工具调用与结果如何表示和闭合 | [Canonical Message](canonical_message.md) |
| 每轮固定什么，每步重新组装什么 | [Context Assembly](context_assembly.md) |
| 如何估算预算、裁剪工具输出和压缩历史 | [Pruning and Compaction](context_pruning_compaction.md) |
| 历史如何落盘、恢复，图片如何保存 | [Context Persistence](context_persistence.md) |

## 与执行循环的关系

1. **Turn 开始**：恢复当前模型视图，追加用户输入及必要的 Skill 工作上下文。
2. **每个 step 前**：取得当前可见工具与环境，归一化消息、修复工具闭合、估算请求预算，按需压缩；模型返回后执行工具并追加结果。
3. **Turn 结束**：可以再次整理长期模型视图。收尾维护失败只记录 warning，不撤销已交付答案。

具体执行和错误分支见 [Runtime 执行流程](../turn_execution.md)。预算默认值只在压缩专题维护，实际窗口来自当前模型定义；有匹配的供应商 usage 时，还会校准本地估算。

## 持久化边界

压缩通过追加 `context_patch` 更新模型视图，不改写原始 JSONL 行。压缩可能将早期消息或当前长 turn 的前半段替换为摘要；是否仍在模型视图中，与原文是否留在 transcript 中，是两件事。

图片在 transcript 中保留原始内容，不因被模型处理过一次就删除。展示、摘要和供应商请求使用各自的投影。思考签名与不透明数据的保存和展示边界见 [Canonical Message](canonical_message.md)。

上下文模块不负责渠道发送、文件写入权限或工具进程控制，这些分别见 [Gateway](../../../desktop/gateway/README.md)、[权限专题](../permission-policy.md)和[工具手册](../tools/README.md)。摘要提示词与策略变更的审查要求统一见 [PR 审查规范](../../../pr-review.md)。
