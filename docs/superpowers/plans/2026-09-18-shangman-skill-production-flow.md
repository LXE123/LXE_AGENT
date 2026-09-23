# 智慧印尼 Skill 识别、生产开关与流程验证实施计划

> **Spec:** `docs/superpowers/specs/2026-09-18-shangman-skill-production-flow-design.md`

## 全局约束

- 在当前 worktree `codex/shangman-erp-export-client` 内工作，不提交、不推送。
- Python 使用 `uv`，JavaScript/TypeScript 使用 `bun`。
- 不访问真实 ERP；所有流程验证使用本地 fixture/fake。
- 保留已有开发端口修复，只修改本任务相关文件。

## 任务 1：固定 Skill 识别契约

- 检查 `SKILL.md`、`catalog.json`、Skill loader 和现有 FBA/Skill 文档测试。
- 为 manifest 发现、`amazon_replenish` 类型、owner skill 和自然语言导出入口补测试。
- 若发现 catalog 或 manifest 不一致，只做最小修正，并运行相关 Python/Bun 定向测试。

## 任务 2：增加持久化生产开关

- 更新 `packages/foundation/desktop-protocol/src/index.ts` 的状态和 setup input。
- 更新 `apps/desktop/src/main/config-store/model.ts`，把 schema 从 9 升到 10；旧配置迁移为关闭。
- 更新 setup state/save/environment 和 IPC 校验，使开关非敏感、默认关闭、清除时关闭。
- 更新 Dashboard settings model、shell UI 和样式；复用现有设置布局，提供 `role=switch`、键盘操作和状态文本。
- 添加/更新配置、协议和设置模型测试。

## 任务 3：验证本地流程通路

- 用现有 workflow/client seam 编写本地 fake ERP 流程测试。
- 覆盖自然语言预览、生产门禁、验证码暂停和继续、最终 XLSX 内容/路径。
- 不引入真实凭据、真实 URL 或网络依赖。

## 任务 4：收口验证和交接

- 运行受影响的 Python/Bun 定向测试、相关 typecheck、`git diff --check`、敏感信息扫描和 `git status`。
- 更新 `docs/handoff/CURRENT_HANDOFF.md`，记录入口、调用链、测试结果和未验证的真实 ERP 限制。
- 不执行 `git add`、`git commit` 或 `git push`。
