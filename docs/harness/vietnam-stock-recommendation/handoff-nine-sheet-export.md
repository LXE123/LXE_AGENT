# 越南备货九表导出 handoff

- 分支 / Pool：`codex/vietnam-stock-full-workbook`，`.worktrees/pool-17`。基线 `origin/main@9f36647a`；主功能提交 `96943964`，聊天模板生命周期修复提交 `8dbc42e4`。本轮旧 SKU map 退役在同一分支收口，未 push、未创建 PR。
- 当前入口：`lxeskill vietnam replenishment calculate` → 三份雅仓报表快照与九表模板（显式本轮文件或 `vietnam_full_workbook` current）→ `workflow.generate_current_vietnam_recommendation` → 模板主表 B/E/G/AE/AJ 参数解析 → `recalculation.generate_vietnam_workbook` 写入/Office 重算/校验五张计算表 → `full_workbook.combine_full_workbook` 合并九表。没有模板即失败，不读取旧 SKU map，不生成旧五表终稿。
- 保留能力：`SkuParameters`、SKU 精确匹配和数值校验、雅仓三表处理、销量/库存/在途/备货/价格公式、模板 current/previous 版本、四张业务表原始 XML 保留。设置页只上传/导出九表模板并保存全局参数；聊天显式模板仅本轮使用，不修改 current。模板没有的雅仓 SKU 仍导出来源行，依赖模板的列留空，不填零。
- 已退役：旧 Desktop IPC、preload、协议状态、上传/导出与 Python 私有动作；CLI `--sku-map-file` / catalog 参数、显式覆盖、旧 `sku-map.xlsx` current 和运行快照、SKU map Store/解析器/校验报告、无模板五表回退、对应测试与使用说明。五张计算表写入器是九表流程的内部步骤，继续保留。
- 修改文件范围：Desktop IPC/预加载/设置服务与测试、Dashboard 设置行为 fixture、desktop-protocol；Python `settings.py`、`asset_contract.py`、`workflow.py`、`recalculation.py`、`workbook.py`、`validation_diagnostics.py`、CLI adapter/catalog 及定向测试；越南 Skill、Runtime Skill 契约断言和通用附件样例、计算说明和本 handoff。删除 map Store、Desktop map export helper 与其专用测试。历史实施计划保持原样；没有新增 Tool、Store、Workflow、框架或持久化层。
- 历史口径变化：旧的显式 map 覆盖现在被参数校验拒绝，结果只来自模板 B/G/AE/AJ；过去无模板但有旧 map 时可输出五表，现在明确提示上传或指定九表模板。
- 环境：生产仍使用 `LXE_DATA_ROOT`、既有 Office Kit 运行时配置；没有新增环境变量、依赖或密钥。测试使用 `LXE_OFFICE_NODE`、`LXE_OFFICE_CLI` 指向 checkout 内宿主 Office Kit。
- 九表 golden：以两 SKU 合成雅仓三表和完整九表模板，在删除前后各执行一次真实 Office Kit CLI，比较 9 张表的顺序、行列尺寸、212 个非空格的值与公式缓存、最终备货量及价格相关列，以及四张业务表 XML；全部一致。两条路径均生成有效九表。差异仅在已取消的旧 map 覆盖和无模板调用口径。
- 定向验证：越南模块和相关 CLI 测试 `235 passed, 7 skipped`（随后单独配置 Office Kit 的 7 项 `7 passed`）；模板资产、工作流与 CLI 再验 `52 passed`；Bun catalog 契约 `12 passed`、Runtime 执行审批契约 `1 passed`；Desktop 桥接/设置 `9 passed`、输入资产版本 `4 passed`；Dashboard 越南设置页 Chromium 行为测试 `1 passed`；Desktop 与 Dashboard typecheck 通过。本轮收口后 Skill 契约 `13 passed`，Runtime 附件相关目标 `4 passed`。额外扩大运行 CLI/infra 时曾有 `576 passed, 59 failed, 4 skipped`，59 项因沙箱拒绝绑定本机回环端口失败；随后在沙箱外复测相关 5 个文件 `75 passed`，不把早先扩大测试记为全量通过。
- 提交前本地服务 smoke：隔离临时数据目录，通过真实 Desktop 设置服务上传并读取九表 current；使用两条合成 SKU 的雅仓三表执行正式 CLI 和 Office 重算，生成九表，校验 `passed`、SKU 数为 2，主表 B/G/AE/AJ 与模板一致，四张业务表仍在。旧 `--sku-map-file` 被 CLI 拒绝；只有旧 `sku-map.xlsx` 而没有九表模板时返回 `input_required`；旧桌面私有 `upload` 动作被拒绝。未使用真实 ERP 或生产数据，未覆盖真实 Electron UI 交互。
- 用户本地交互检查：设置页上传后 current 可读；随后聊天指令为“查询越南备货信息”，Runtime 成功读取并发送已有结果。该会话没有重新执行九表计算，因此不计为聊天附件到新 Excel 的端到端验证。
- 最终提交前复测：Python CLI/infra 契约 `471 passed, 4 skipped`（在可绑定本机回环端口的环境运行）；越南九表/工作流/设置/集成定向 `29 passed, 7 skipped`；关联 Python catalog/输入资产目标 `181 passed`；Runtime 相关 `147 passed`；Desktop 桥接与设置 `9 passed`；Dashboard Chromium 越南设置页 `1 passed`；Desktop、Dashboard typecheck 通过。受限沙箱内扩展测试曾有 59 项因无法绑定回环端口失败，已在沙箱外复测通过，不计为功能回归。
- 限制：真实雅仓三份生产报表及其业务 SKU 结果 NOT VERIFIED；真实聊天附件发送到最终 Excel 的 UI 端到端 NOT VERIFIED；Windows 与发布 build NOT VERIFIED。合成文件的实际九表生成与 Office 重算已验证。模板公式价依赖 XLSX 保存的计算缓存；四张业务表如带合并器不支持的独立附件关系会报错。
- PR 依赖 / 下一步：本分支基于既有 `origin/main`，无前序 PR 依赖。用户已授权将本轮修改同步到本地分支以准备 PR；push 和创建 PR 尚未授权。合并前按项目规范与最新 main 做兼容检查。

全仓搜索结果：生产链中旧 map 参数、Store、桥接和五表回退无消费者；退役说明、负向测试及未改的历史实施计划仍可出现旧名称，Runtime 通用附件样例已改为九表模板。设置页 CSS 与行为选择器也已统一为 template。本轮修改范围为 41 个相关文件，无新增文件、无敏感信息或无关修改；提交前 `git diff --check` 通过。

实际修改文件：

```text
apps/dashboard/src/features/workbench/vietnam-settings-view.tsx
apps/dashboard/src/features/workbench/vietnam-settings.css
apps/dashboard/test/behavior/README.md
apps/dashboard/test/behavior/renderer.tsx
apps/dashboard/test/behavior/runner.cjs
apps/desktop/src/ipc-channels.ts
apps/desktop/src/main.ts
apps/desktop/src/main/ipc.ts
apps/desktop/src/main/vietnam-map-export.ts
apps/desktop/src/main/vietnam-settings.ts
apps/desktop/src/preload-bridge.ts
apps/desktop/test/preload-bridge.test.ts
apps/desktop/test/vietnam-map-export.test.ts
apps/desktop/test/vietnam-settings.test.ts
docs/harness/vietnam-stock-recommendation/calculation.md
docs/harness/vietnam-stock-recommendation/handoff-nine-sheet-export.md
packages/agent/runtime/test/engine/runtime.test.ts
packages/agent/runtime/test/permissions/approvals.test.ts
packages/agent/runtime/test/tooling/lxeskill-command.test.ts
packages/agent/runtime/test/tooling/skills.test.ts
packages/foundation/desktop-protocol/src/index.ts
python/lxeskill_cli/lxeskill/catalog.json
python/lxeskill_cli/services/agent_cli/vietnam_replenishment/generate.py
python/lxeskill_cli/services/vietnam_replenishment/asset_contract.py
python/lxeskill_cli/services/vietnam_replenishment/recalculation.py
python/lxeskill_cli/services/vietnam_replenishment/settings.py
python/lxeskill_cli/services/vietnam_replenishment/sku_map_store.py
python/lxeskill_cli/services/vietnam_replenishment/validation_diagnostics.py
python/lxeskill_cli/services/vietnam_replenishment/workbook.py
python/lxeskill_cli/services/vietnam_replenishment/workflow.py
python/lxeskill_cli/tests/lxeskill/test_export_command_names.py
python/lxeskill_cli/tests/lxeskill/test_vietnam_recommendation_cli.py
python/lxeskill_cli/tests/vietnam_replenishment/test_asset_contract.py
python/lxeskill_cli/tests/vietnam_replenishment/test_map_export.py
python/lxeskill_cli/tests/vietnam_replenishment/test_pr5_integration.py
python/lxeskill_cli/tests/vietnam_replenishment/test_recalculation.py
python/lxeskill_cli/tests/vietnam_replenishment/test_settings.py
python/lxeskill_cli/tests/vietnam_replenishment/test_validation_diagnostics.py
python/lxeskill_cli/tests/vietnam_replenishment/test_workbook.py
python/lxeskill_cli/tests/vietnam_replenishment/test_workflow.py
skills/vietnam-replenishment/SKILL.md
```
