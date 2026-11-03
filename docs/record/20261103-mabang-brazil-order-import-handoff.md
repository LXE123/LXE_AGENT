# 巴西备货清单生成马帮订单模板：模块交接

- **分支 / Worktree**：`codex/mabang-brazil-template` / `.worktrees/pool-9`；基于 `2ba421c55182101315315397ff65195112c342ba`。2026-11-03 同步时 `origin/main` 与 `arsenal/main` 均为该提交；后续合并前应重新确认远端状态。
- **完成范围**：新增确定性 XLSX 生成 CLI、Workflow、工作簿 Service、随包模板资源及自然语言 Skill；不接入马帮在线接口，不提交订单。
- **调用链**：`lxeskill mabang brazil order-import generate --input-xlsx <path> [--shipping-column AT:BD]` → command wrapper → `services.mabang.brazil_order_import.workflow.run` → `workbook.generate_order_workbook` → 内置 `template.xlsx`。
- **规则**：读取 `巴西` sheet、F 列 `sku` 和 AT:BD 的海运日期表头；月/日按离当前中国日期最近的年份解析。从全部海运列选择距当前中国日期最近的一列，过去和将来的日期都参与比较，表头颜色不影响选择。最近日期并列时停止，显式 `shipping_column` 仅可选择最近候选列。SKU 或所选数量列的公式没有缓存结果时，报告坐标并要求重算保存；有缓存公式使用其缓存值。按输入顺序保留重复 SKU，空数量保持空白；A/B 同写 `BRYYMMDD-H`。输出复制模板默认字段和样式，并按数据行数扩展自动筛选范围。
- **自然语言入口**：`skills/mabang-brazil-order-import-generate/SKILL.md` 接收本轮上传的 `.xlsx` 附件，要求使用真实绝对路径调用命令。最近日期并列时先询问用户；成功后交付 `files` 中的文件和订单/SKU/日期摘要。Catalog 已将命令设为 `business`、`exposed: true`，并登记该 Skill 所有权。
- **修改文件**：`pyproject.toml`、`python/lxeskill_cli/lxeskill/catalog.json`、`python/lxeskill_cli/services/mabang/brazil_order_import/`、`python/lxeskill_cli/services/commands/mabang/brazil_order_import_generate.py`、相关巴西导出及 CLI 契约测试、`skills/mabang-brazil-order-import-generate/SKILL.md`、`docs/lxeskill-cli/commands.md`、本交接记录。
- **产物与配置**：产物使用 `mabang_brazil_order_import` dataset；运行时以 `Asia/Shanghai` 取日期。无新环境变量、凭据或登录依赖。源备货清单未加入仓库；内置模板仅作为资源文件。
- **验证**：2026-11-03 日期规则调整后，`UV_CACHE_DIR=/private/tmp/codex-uv-cache uv run --frozen --no-sync pytest -q python/lxeskill_cli/tests/mabang/test_brazil_order_import_template.py python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra` 在允许本地回环的环境中为 423 passed、4 skipped；`bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts` 为 3 passed。命令手册生成器再次运行显示已同步。原备货表本轮离线生成并校验成功：选中 BD `11/2海运`，10,484 条 SKU、267 个数量值，本机约 59 秒。此前还验证了 15 SKU 精简测试本，并构建了包含模板的 wheel；上述离线结果不能替代真实导入验收。
- **Skill 文案复核**：明确备货表输入、随包模板及命令执行路径，精简重复限制性表述。文案调整后，Skill 归属与命令契约定向测试 61 passed。
- **已知边界**：SKU 单元格需为文本；AT:BD 表头需符合 `月/日[字母]海运`。公式已有缓存值时使用该值，不能判断缓存是否过期。真实样本未覆盖日期并列，已由合成用例覆盖。自然语言 Skill 的桌面端完整调用链和真实马帮导入尚未验收。当前冻结环境未安装 `pytest-cov` / `coverage`，本次未取得行/分支覆盖率数据。
- **Git / PR**：功能提交 `660e5614` 已推送至 `arsenal/codex/mabang-brazil-template`，PR 为 `Arsenal20262/LXE_AGENT#12`；审查修复及日期规则变更尚未提交或推送。现有 PR 正文仍描述标黄优先，需要在后续获授权更新时同步修正。用户计划自行向 `LXE123/LXE_AGENT` 提交 PR。
- **下一步**：审阅修复的 diff、验证结果及限制；依项目规范分别取得 Commit、Push 和修改 PR 的授权后更新现有 PR 及其说明。
