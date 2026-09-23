# 智汇 TMS 确认式路由实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop 的智汇商品查询直接显示一次预览及确认卡，用户确认后最多执行一次导出。

**Architecture:** 在 Bun 运行时用户消息入库后增加智汇专用路由。路由使用现有 CLI runner 和问题服务，结果仍经运行时消息、流输出及附件记录。未匹配请求继续原有模型流程。

**Tech Stack:** Bun、TypeScript、现有 `UserQuestionService`、`OneShotCliRunner`、Python `lxeskill`。

**Spec:** `docs/superpowers/specs/2026-09-17-zhihui-tms-confirmation-router-design.md`

## Global Constraints

- 只在当前 Pool / `codex/zhihui-tms-client-auth` 分支开发；不碰雅仓。
- 使用假 CLI 响应测试；不调用真实智汇接口或读取凭据。
- 保留现有生产开关、限速、重试、风控停止、账号锁和附件语义。
- 不运行 `git add`、`git commit` 或 `push`，直到用户对精确文件和提交信息另行批准。

---

### Task 1: 确定性匹配和安全问题卡

**Files:**
- Create: `packages/agent/runtime/src/operations/zhihui-confirmation.ts`
- Modify: `packages/agent/runtime/src/tooling/user-questions.ts`
- Test: `packages/agent/runtime/test/operations/zhihui-confirmation.test.ts`

**Interfaces:** `matchZhihuiProductRequest(text, previousUserText): string | undefined`；`UserQuestionService.askForTurn(questions, {sessionId, turnId, signal}): Promise<UserQuestionAnswer[]>`。

- [x] 写先失败的 matcher 测试：智汇销量、智汇入库时间、延续上下文的“查询销量”命中；订单、独立历史报表和其他平台不命中。
- [x] 写先失败的问题服务测试：确认、取消、跳过、重复提交和停止回合；等待期间问题卡在 snapshot 中可见。
- [x] 实现 matcher 与 `askForTurn`，使公开 `ask_user_question` 继续使用同一问题所有者。
- [x] 运行上述定向测试并检查真实失败与通过结果。

### Task 2: 运行时预览、确认和执行

**Files:**
- Modify: `packages/agent/runtime/src/engine/runtime.ts`
- Modify: `packages/agent/runtime/src/tooling/one-shot-cli.ts`
- Modify: `apps/agent-cli/src/runtime-host.ts`
- Modify: `packages/agent/runtime/src/operations/zhihui-confirmation.ts`
- Test: `packages/agent/runtime/test/engine/zhihui-confirmation.test.ts`

**Interfaces:** `ZhihuiTmsConfirmationRouter.handle(input, context): Promise<ZhihuiRouteResult | undefined>`；注入假 `OneShotCliRunnerPort` 与问题服务。CLI 参数分别为 `['tms','philippines','products-export','--action','preview','--request',request]` 和 `execute`。

- [x] 写先失败的运行时回归测试：匹配时模型调用次数为 0；一次预览后可见确认卡；确认仅执行一次；取消、跳过和 abort 零执行；未匹配请求仍进入模型。
- [x] 实现预览结果校验，预览失败时保留 CLI 真实脱敏错误；结果说明明确全量商品导出不是历史报表。
- [x] 在运行时的输入持久化阶段接入路由，完成消息与终态流交付；确认后调用执行，成功交付文件，失败交付已有分页文件并展示真实脱敏错误。
- [x] 让一次性 CLI runner 可选地逐条转交白名单智汇进度到现有 Desktop 工具卡；不得转交原始 URL、账号或 Token。
- [x] 检查执行时生产开关、凭据和账号锁仍由原 CLI 裁决；失败不自动重新执行。
- [x] 运行相关 Bun 定向测试与 Python 智汇测试。

### Task 3: 收口与交接

**Files:**
- Modify: `skills/zhihui-tms-product-export/SKILL.md`
- Create: `docs/superpowers/handoffs/2026-09-17-zhihui-tms-confirmation-router.md`

- [x] 更新 Skill 说明，统一界面确认卡与 CLI 明确执行的语义。
- [x] 运行受影响包的定向测试、类型检查和 `git diff --check`；检查状态、敏感信息与无关改动。
- [x] 写交接文档：分支/Pool、完成内容、修改文件、入口调用链、环境变量、测试结果、已知限制、下一步。
- [ ] 列出精确文件与英文提交信息，申请用户对 `git add`、`git commit` 单独批准。
