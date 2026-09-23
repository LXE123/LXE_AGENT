# 雅仓 AI 结构化意图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让雅仓公开 Skill 由 AI 直接传结构化意图，代码只做确定性校验、规划和执行。

**Architecture:** 保留现有导出计划和执行器；将 `export_intent.py` 的公开职责收敛为结构化候选校验和确定性归一化。旧 `request_text` 入口暂时保留为兼容路径，但公开 catalog 的 required 字段切换为四个结构化意图字段。

**Tech Stack:** Python、uv、Bun catalog tests、YAML frontmatter、JSON Schema-like catalog input schema。

**Spec:** `docs/superpowers/specs/2026-09-18-yacang-ai-structured-intent-design.md`

## Global Constraints

- 不猜测接口参数、ID、分页、日期或仓库；未知输入必须失败或澄清。
- Python 使用 `uv`，JavaScript 使用 `bun`。
- 生产请求继续由 `LXE_YACANG_PROD_ENABLED=true` 和现有生产门禁控制。
- 不自动执行 `git push`。

---

### Task 1: 固定结构化参数契约

**Files:**
- Modify: `python/lxeskill_cli/services/yacang/export_intent.py`
- Modify: `python/lxeskill_cli/services/yacang/export_workflow.py`
- Test: `python/lxeskill_cli/tests/yacang/test_export_intent.py`
- Test: `python/lxeskill_cli/tests/yacang/test_export_workflow.py`

**Interfaces:**
- 新增结构化入口 `normalize_structured_intent(...)`。
- `run_export_workflow` 接受结构化候选并不调用 `parse_request_text`。
- 保留 `normalize_export_intent(request_text, ...)` 作为旧兼容适配器。

- [ ] 为 resolved/omitted/ambiguous、explicit date、非法日期和不支持范围补测试。
- [ ] 运行 `uv run pytest python/lxeskill_cli/tests/yacang/test_export_intent.py python/lxeskill_cli/tests/yacang/test_export_workflow.py`，先确认新测试失败。
- [ ] 实现结构化归一化和日期校验；默认值仍由代码确定性补全。
- [ ] 重新运行上述定向测试并确认通过。

### Task 2: 切换 CLI 与 catalog 输入

**Files:**
- Modify: `python/lxeskill_cli/services/agent_cli/yacang/export_workflow.py`
- Modify: `python/lxeskill_cli/lxeskill/catalog.json`
- Modify: `skills/yacang-export-workflow-map/SKILL.md`
- Test: `python/lxeskill_cli/tests/yacang/test_cli_boundaries.py`
- Test: `python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py`

**Interfaces:**
- 公开 `yacang_export_workflow` required 输入为四个结构化意图字段。
- CLI 将结构化输入传给 `run_export_workflow`；`request_text` 只保留内部兼容调用。

- [ ] 更新 catalog schema，explicit range 要求 `start_date`、`end_date`。
- [ ] 更新 Skill 文档，明确 AI 负责翻译，禁止传原始 query 作为正常输入。
- [ ] 更新 CLI 边界和 catalog 契约测试。
- [ ] 运行 `uv run pytest python/lxeskill_cli/tests/yacang/test_cli_boundaries.py python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py`。

### Task 3: 清理公开自然语言依赖并完成验证

**Files:**
- Modify: `python/lxeskill_cli/services/yacang/export_intent.py`
- Modify: `docs/handoff/yacang-production-toggle.md`

- [ ] 确认新公开路径没有调用 `parse_request_text`。
- [ ] 保留旧兼容路径并在交接文档记录迁移边界。
- [ ] 运行 `uv run pytest python/lxeskill_cli/tests/yacang python/lxeskill_cli/tests/lxeskill/test_fba_skill_docs.py`。
- [ ] 运行 `git diff --check`、敏感信息扫描和 `git status`。
- [ ] 提议按项目规范创建英文 commit，不执行 push。
