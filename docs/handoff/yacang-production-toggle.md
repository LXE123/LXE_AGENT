# 雅仓生产开关交接

- 当前分支/Pool：`feature/new-yacang-module` / `pool-3`
- 完成内容：在桌面设置的“业务集成 → 雅仓”中增加“允许雅仓生产请求”复选框，默认关闭；开关状态随雅仓账号配置保存。
- 调用链：Dashboard 雅仓设置页 → `DesktopSetupInput.yacang.production_enabled` → `DesktopSetupService` 配置仓库 → `LXE_YACANG_PROD_ENABLED` → `YacangProductionGuard`。
- 修改文件：`apps/dashboard/src/desktop/shell.tsx`、`settings-model.ts`、`shared/i18n.tsx`、`styles.css`；`apps/desktop/src/main/config-store/{model,setup}.ts`、`ipc-validation.ts`、`yacang-test-page.ts`；`packages/foundation/desktop-protocol/src/index.ts`；相关桌面配置测试。
- 环境变量：运行时由配置生成 `LXE_YACANG_PROD_ENABLED=true/false`，不需要用户手动编辑环境变量；账号和密码仍走现有安全存储。
- 验证结果：定向 Bun 测试 49 个通过；`bun run typecheck` 通过；Dashboard `tsc -b && vite build` 通过；`git diff --check` 通过。
- 已知限制：未配置完整雅仓账号和密码时，生产复选框不可勾选；本次没有执行真实雅仓登录或生产导出。
- 下一步：在本地桌面页面确认开关显示、保存和重启后状态恢复；完成后将该分支合并到集成分支。

## AI 结构化意图迁移

- 雅仓公开 Skill 现在要求 AI 传 `data_type_intent`、`warehouse_intent`、`created_date_filter` 和 `inventory_snapshot_intent`；代码不再从新调用的原始用户话语中解析业务意图。
- `request_text` 保留为旧调用兼容入口，后续所有新 Skill 调用应使用结构化参数。
- 结构化入口会校验枚举、仓库、日期和跨字段范围；模糊参数在发出网络请求前返回 `needs_clarification`。
- 相关设计与计划：`docs/superpowers/specs/2026-09-18-yacang-ai-structured-intent-design.md`、`docs/superpowers/plans/2026-09-18-yacang-ai-structured-intent.md`。
- 结构化迁移验证：雅仓全目录与 Skill catalog 回归 376 个测试通过。
