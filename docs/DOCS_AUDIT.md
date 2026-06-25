# Docs Audit

日期：2026-06-19

这是 `docs/` 的第一版盘点。目标是先建立分类和可信边界，再决定哪些内容要重写、移动或删除。

## Summary

根因：`docs/` 里同时存在当前手册、设计笔记、草稿、日期记录、阶段日志和运行时 skill 素材，但没有状态标签。读者无法判断哪篇文档是当前事实。

第一批先新增入口和审计报告；后续清理批次继续在本文件记录实际删除、脱敏和重建结果。

## Inventory

本批新增索引和审计报告之前，Git 跟踪的 docs 基线：

- `docs/` 下 76 个 tracked 文件
- 75 个 tracked Markdown 文件
- 1 个 tracked 非 Markdown 文件：`docs/harness/skill/reference/ziniao-webdriver-doc/_meta.json`

本地文件系统中的 docs：

- `docs/` 下 78 个文件
- `docs/` 下 76 个 Markdown 文件
- ignored 本地文件：`docs/.DS_Store`、`docs/sidecar_soak.md`

tracked Markdown 的质量信号：

- 4 个空 Markdown 文件
- 45 个 Markdown 文件没有任何 Markdown 标题
- 16 个 draft-like 文档
- 13 个 phase/stage-like 文档
- 4 个 dated record 文档

## Empty Documents

以下文件被 Git 跟踪，但内容为空，不能视为当前文档：

- `docs/feishu/feishu.md`
- `docs/tool_draft/更新物流数据.md`

## Draft-Like Documents

以下文件或目录看起来是草稿、未完成设计或原始流程记录：

- `docs/harness/skill/archive/amazon_fba/fba-*/`
- `docs/harness/skill/archive/amazon_replenish/replenishment-*/`
- `docs/harness/skill/archive/unmapped/`
- `docs/log_collection/draft.md`
- `docs/tool_draft/更新物流数据.md`

## Phase And Dated Records

phase-like 文档：

- `docs/harness/skill/archive/amazon_fba/fba-shipment-create/`
- `docs/install.md`

dated record 文档：

- `docs/goals/20260530-goals.md`
- `docs/harness/skill/archive/amazon_fba/fba-shipment-create/`
- `docs/record/20260608.md`

## Initial Classification

Current candidates：

- `README.md`
- `docs/py31210.md`
- `docs/database/local_agent.md`
- `docs/eventloop.md`
- `docs/harness/runtime/README.md`
- `docs/harness/runtime/runtime_flow.md`
- `docs/harness/runtime/turn_execution.md`
- `docs/harness/llm/README.md`
- `docs/harness/llm/provider_catalog.md`
- `docs/harness/llm/streaming_adapter.md`
- `docs/harness/gateway/README.md`
- `docs/harness/runtime/context/README.md`
- `docs/harness/runtime/tools/README.md`
- `docs/harness/runtime/tools/tool_schema.md`
- `docs/harness/runtime/tools/tool_execution.md`
- `docs/harness/skill/README.md`
- `docs/harness/skill/current_skill_catalog.md`
- `docs/harness/skill/archive/README.md`
- `docs/harness/skill/reference/README.md`
- `data/README.md`
- `browser_auth_service/README.md`
- `skills/*/SKILL.md`

Needs refresh：

- `docs/install.md`：安装脚本规划笔记；当前用户入口更接近 README 和 scripts 实现。
- `docs/visualization/preliminary_idea.md`：早期 Dashboard 设想；当前实现是 `gateway/dashboard/api.py` 和 `web/agent-dashboard/src/main.tsx`。

Reference：

- `docs/harness/skill/reference/ziniao-webdriver-doc/SKILL.md`
- `docs/harness/skill/reference/ziniao-webdriver-doc/references/*`
- `docs/ding/*`

Draft or archive：

- `docs/harness/skill/archive/amazon_fba/fba-*/`
- `docs/harness/skill/archive/amazon_replenish/replenishment-*/`
- `docs/harness/skill/archive/unmapped/`
- `docs/goals/*`
- `docs/record/*`
- `docs/tool_draft/*`

## Completed Docs

- `docs/harness/runtime/README.md` 和 `docs/harness/runtime/turn_execution.md`：已补 runtime Current 入口和 turn execution 专题，覆盖 `TurnHandler -> run_turn -> AgentLoop -> TurnOutcome -> persist/final emit`；旧 3 篇无状态 runtime 设计稿已删除。
- `docs/harness/runtime/runtime_flow.md`：已从旧 runtime 架构总览重写为端到端运行链路总览，作为跨 gateway/runtime/context/tools 的导航图。
- `docs/harness/llm/`：已从 runtime 目录拆到 harness 级专题，并按当前 `agent_runtime/llm_adapter.py` 和 `shared/llm/` 重建 LLM provider integration Current 文档，覆盖 provider catalog、模型选择、Anthropic Messages streaming adapter 和 `LLMResponse`；旧 loose LLM 笔记、模型笔记、协议笔记和空占位已删除。
- `docs/harness/gateway/`：已删除两篇旧 gateway 文档，并按当前代码重建为 Current 专题目录，覆盖生命周期、平台边界、路由权限、调度取消和出站唤醒。
- `docs/harness/runtime/context/`：已重建为 Current runtime context 专题目录，覆盖 context state、canonical messages、context assembly 和 pruning/compaction。
- `docs/harness/runtime/tools/tool_schema.md`：已从 context 文档中拆出，作为 runtime tools 下的 current tool schema 文档。
- `docs/harness/runtime/tools/tool_execution.md`：已补 runtime tool execution 生命周期，覆盖 registry lookup、`ToolExecutionContext`、handler 调用、`ToolResult`、取消、final answer stream 工具状态和 canonical `tool_result` 写回。
- `docs/harness/skill/` 敏感旧记录第一批：删除 1 个真正空占位文件，保留 7 篇脱敏旧 skill 流程记录；保留业务流程、关键 endpoint/selector 思路和字段说明，不把它们提升为当前运行时 skill 文档。
- `docs/harness/skill/README.md` 和 `docs/harness/skill/current_skill_catalog.md`：已按当前运行中 `skills/*/SKILL.md` 重建 skill 文档入口和 catalog，覆盖 `amazon_fba`、`amazon_replenish`、`default` 三类 skill。
- `docs/harness/skill/` 物理规范化：旧草稿、阶段记录、脱敏流程记录和紫鸟参考资料已分流到 `archive/` 和 `reference/`，归档目录已对齐当前 runtime skill slug，并统一标题、状态头和 truth source 说明；未修改 `/skills/*/SKILL.md`。

## Missing High-Priority Docs

后续批次优先补这些：

- Dashboard 使用说明：本地 URL、功能 tab、API endpoints、模型切换、thinking 设置和后台任务视图。
- 环境配置说明：`.env.example` 中 LLM、Feishu、Mabang、Ziniao、Dashboard、Data Server、trace 的配置含义。
- Feishu 平台说明：消息进入、CardKit 回复、typing indicator、媒体处理和必要 app scopes。

## Notes

- `skills/*/SKILL.md` 是运行时 skill 的事实来源。`docs/` 应该链接它们，而不是复制提示词内容。
- `docs/harness/skill/archive/` 和 `docs/harness/skill/reference/` 保存历史材料和外部资料，不代表当前 runtime skill。
- `docs/sidecar_soak.md` 被 Git 忽略，本批先视为本地 PoC 文档。
