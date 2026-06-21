# Docs 入口

这里是 LXE Agent 文档的入口。

第一条维护规则：如果一篇文档没有出现在本文件或 `DOCS_AUDIT.md` 中，先把它当成未分类文档，不要默认认为它是当前事实。当前 docs 漂移的根因不是某一篇文档没更新，而是正式手册、设计笔记、草稿、阶段记录和运行时 skill 提示词长期混在同一棵目录树里，没有状态标签。

## 状态标签

| 状态 | 含义 |
| --- | --- |
| `Current` | 已和当前代码、README 或测试对齐，可以作为工作参考。 |
| `Needs Refresh` | 内容有价值，但依赖细节需要先对照当前代码更新。 |
| `Draft` | 想法、草稿、未完成设计或待验证流程。 |
| `Archive` | 历史排障、日期记录、阶段记录。 |
| `Reference` | 外部平台、API、协议或供应商资料。 |

## 当前可信入口

优先从这些文档开始：

- `Current` [Project README](../README.md)：项目概览、快速安装、运行要求和开发检查。
- `Current` [Python 3.12.10 / uv 部署说明](py31210.md)：Python 和依赖管理规则。
- `Current` [Local agent database layout](database/local_agent.md)：SQLite 状态、保留的 PostgreSQL pricing 范围和 runtime notes。
- `Current` [Event loop architecture](eventloop.md)：asyncio runtime 和关闭策略。
- `Current` [Runtime](harness/runtime/README.md)：agent runtime 架构、turn execution、context 和 tools 文档入口。
- `Current` [LLM Integration](harness/llm/README.md)：模型供应商 catalog、streaming adapter 和 `LLMResponse`。
- `Current` [Gateway](harness/gateway/README.md)：gateway 生命周期、平台边界、路由权限、调度取消和出站唤醒。
- `Current` [Skill docs and catalog](harness/skill/README.md)：当前运行中 skill catalog 和旧 skill 文档分类入口。
- `Current` [本机业务数据目录](../data/README.md)：私有 Excel/template 文件路径。
- `Current` [Browser auth service](../browser_auth_service/README.md)：马帮登录态刷新 CLI 和诊断方式。
- `Current` [Runtime skills](../skills)：agent 实际加载的 skill 提示词来源。

## Runtime Skill 文档

正式运行时 skill 文档在 `skills/*/SKILL.md`。这些文件由 `agent_runtime.skill_index` 加载，并且有测试覆盖。

当前运行中 skill 摘要见 [Skill docs and catalog](harness/skill/README.md) 和 [Current skill catalog](harness/skill/current_skill_catalog.md)。

旧 skill 草稿、实现笔记、流程录制和参考资料已经分流到 [Skill archive](harness/skill/archive/README.md) 和 [Skill references](harness/skill/reference/README.md)。除非当前 `skills/*/SKILL.md` 明确指向它们，否则不要把归档材料当成运行时提示词来源。

带有 `Archive / Sanitized` 状态的旧 skill 记录已经开始脱敏；它们只保留历史流程参考，不代表当前凭据、选择器或运行逻辑。

常用 workflow map：

- [FBA workflow map](../skills/fba-workflow-map/SKILL.md)
- [Replenishment workflow map](../skills/replenishment-workflow-map/SKILL.md)

## 需要刷新

这些区域有价值，但使用前需要对照当前代码：

- `Needs Refresh` [Install script planning](install.md)：安装脚本设计笔记，不是最终用户手册。
- `Needs Refresh` [Dashboard/UI idea](visualization/preliminary_idea.md)：早期 UI 设想，当前实现是 React 加 FastAPI。

## 草稿和归档

以下文档只作为历史上下文或后续整理素材：

- `Archive` `docs/harness/skill/archive/amazon_fba/fba-*/`
- `Archive` `docs/harness/skill/archive/amazon_replenish/replenishment-*/`
- `Archive` `docs/harness/skill/archive/unmapped/`
- `Reference` `docs/harness/skill/reference/`
- `Archive` `docs/goals/*`
- `Archive` `docs/record/*`
- `Draft` `docs/tool_draft/*`

## 维护规则

- 新增面向使用者的文档后，要同步登记到这个入口。
- 不要把完整运行时 skill 提示词复制到 `docs/`，链接到 `skills/*/SKILL.md` 即可。
- 更新旧草稿时，要么在这里提升为 `Current`，要么继续标为 `Needs Refresh`、`Draft` 或 `Archive`。
- 第一版盘点和清理 backlog 见 [DOCS_AUDIT.md](DOCS_AUDIT.md)。
