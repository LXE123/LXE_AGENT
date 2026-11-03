# 巴西备货清单生成马帮订单模板：模块交接

- **PR / 基线**：[PR #140](https://github.com/LXE123/LXE_AGENT/pull/140)，源分支 `Arsenal20262:codex/mabang-brazil-template`；最终审查已合入 `main` 基线 `770eb25f` 和作者修复 `4b9767b`。
- **完成范围**：新增确定性 XLSX 生成 CLI、Workflow、工作簿 Service、随包模板资源及自然语言 Skill；不接入马帮在线接口，不提交订单。
- **调用链**：`lxeskill mabang brazil order-import generate --input-xlsx <path> [--shipping-column AT:BD]` → command wrapper → `services.mabang.brazil_order_import.workflow.run` → `workbook.generate_order_workbook` → 内置 `template.xlsx`。
- **规则**：读取 `巴西` sheet、F 列 `sku` 和 AT:BD 的海运日期表头；月/日按离当前中国日期最近的年份解析。从全部海运列选择距当前中国日期最近的一列，过去和将来的日期都参与比较，表头颜色不影响选择。最近日期并列时停止，显式 `shipping_column` 仅可选择最近候选列。SKU 或所选数量列的公式没有缓存结果时，报告坐标并要求重算保存；有缓存公式使用其缓存值。按输入顺序保留重复 SKU，空数量保持空白；A/B 同写 `BRYYMMDD-H`。输出复制模板默认字段和样式，并按数据行数扩展自动筛选范围。
- **自然语言入口**：`skills/mabang-brazil-order-import-generate/SKILL.md` 接收本轮上传的 `.xlsx` 附件，要求使用真实绝对路径调用命令。最近日期并列时先询问用户；成功后交付 `files` 中的文件和订单/SKU/日期摘要。Catalog 已将命令设为 `business`、`exposed: true`，并登记该 Skill 所有权。
- **修改文件**：`pyproject.toml`、`python/lxeskill_cli/lxeskill/catalog.json`、`python/lxeskill_cli/services/mabang/brazil_order_import/`、`python/lxeskill_cli/services/commands/mabang/brazil_order_import_generate.py`、相关巴西导出及 CLI 契约测试、`skills/mabang-brazil-order-import-generate/SKILL.md`、`docs/lxeskill-cli/commands.md`、本交接记录。
- **产物与配置**：产物使用 `mabang_brazil_order_import` dataset；运行时以 `Asia/Shanghai` 取日期。无新环境变量、凭据或登录依赖。源备货清单未加入仓库；内置模板仅作为资源文件。
- **作者验证记录**：原备货表离线生成并校验成功：选中 BD `11/2海运`，10,484 条 SKU、267 个数量值，本机约 59 秒。此前还验证了 15 SKU 精简测试本；这些离线结果不能替代真实导入验收。
- **最终回归验证**：`uv run --frozen pytest python/lxeskill_cli/tests/mabang python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra` 为 1495 passed、5 skipped（均为 Windows 专用），无失败；`bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts` 为 3 passed。新功能测试共 21 项，覆盖无缓存 SKU/数量公式、失败时不覆盖已有产物、缓存文本和零数量、以等号开头的文本 SKU、真实 CLI 失败时不交付文件，以及颜色不影响最近日期和并列选择。
- **产物与文档验证**：8 组隔离合成 XLSX 经真实 CLI 验证：普通值、缓存公式、文本 SKU、空数量正确交付；两种标准黄色均不影响最近日期选择；无缓存公式返回含坐标的错误且不交付文件。wheel 构建通过，模板和业务代码与源文件逐字节一致；命令手册与生成器输出一致。Skill 已补充公式缓存输入要求。
- **已知边界**：SKU 单元格需为文本；AT:BD 表头需符合 `月/日[字母]海运`。公式已有缓存值时使用该值，不能判断缓存是否过期。真实样本未覆盖日期并列，已由合成用例覆盖。自然语言 Skill 的桌面端完整调用链和真实马帮导入尚未验收。当前冻结环境未安装 `pytest-cov` / `coverage`，本次未取得行/分支覆盖率数据。
