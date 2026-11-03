# 巴西备货清单生成马帮订单模板：模块交接

- **分支 / Worktree**：`codex/mabang-brazil-template` / `.worktrees/pool-9`；基于本地 `origin/main` `2ba421c55182101315315397ff65195112c342ba`。远端最新 `main` 未确认：本机代理连接 GitHub 失败。
- **完成范围**：新增确定性 XLSX 生成 CLI、Workflow、工作簿 Service、随包模板资源及自然语言 Skill；不接入马帮在线接口，不提交订单。
- **调用链**：`lxeskill mabang brazil order-import generate --input-xlsx <path> [--shipping-column AT:BD]` → command wrapper → `services.mabang.brazil_order_import.workflow.run` → `workbook.generate_order_workbook` → 内置 `template.xlsx`。
- **规则**：读取 `巴西` sheet、F 列 `sku` 和 AT:BD 的海运日期表头；月/日按离当前中国日期最近的年份解析。有标黄海运表头时优先在标黄列中选最近日期；没有标黄时再看所有日期列。同日或优先候选最近日期并列时停止，显式 `shipping_column` 仅可选择最近候选列。按输入顺序保留重复 SKU，空数量保持空白；A/B 同写 `BRYYMMDD-H`。输出复制模板默认字段和样式，并按数据行数扩展自动筛选范围。
- **自然语言入口**：`skills/mabang-brazil-order-import-generate/SKILL.md` 接收本轮上传的 `.xlsx` 附件，要求使用真实绝对路径调用命令。优先候选日期并列时先询问用户；成功后交付 `files` 中的文件和订单/SKU/日期摘要。Catalog 已将命令设为 `business`、`exposed: true`，并登记该 Skill 所有权。
- **修改文件**：`pyproject.toml`、`python/lxeskill_cli/lxeskill/catalog.json`、`python/lxeskill_cli/services/mabang/brazil_order_import/`、`python/lxeskill_cli/services/commands/mabang/brazil_order_import_generate.py`、`python/lxeskill_cli/tests/mabang/test_brazil_order_import_template.py`、`skills/mabang-brazil-order-import-generate/SKILL.md`、本交接记录。
- **产物与配置**：产物使用 `mabang_brazil_order_import` dataset；运行时以 `Asia/Shanghai` 取日期。无新环境变量、凭据或登录依赖。源备货清单未加入仓库；内置模板仅作为资源文件。
- **验证**：巴西导出与 Skill/命令契约定向 pytest 共 71 项通过；源文件 BD1 `11/2海运` 的黄色填充已识别。基于原清单制作的精简测试本保留 8 个工作表及说明文字、巴西表 15 条商品，包含 `11/19` 与 `12/20` 日期列；黄色 BD1 `12/20A海运` 优先识别成功，生成结果包含 15 个 SKU 和 15 个数量值。原有真实样本记录为 10,484 条 SKU、保留 24 条重复、写入 267 个数量值并通过输出校验；本地 wheel 构建成功且含 `template.xlsx`。测试冗余审计将重复表头准备合并为 pytest fixture，测试文件 221→212 行（减少 9 行，约 4.1%），保留 10 个声明/11 个收集项；没有安全可删的独立测试。
- **已知边界**：SKU 单元格需为文本；AT:BD 表头需符合 `月/日[字母]海运`。识别填充色为标准黄色（纯黄 RGB/indexed yellow）；真实样本未覆盖日期并列，已由合成用例覆盖。自然语言 Skill 的桌面端完整调用链仍需用户按真实导入流程验收。当前冻结环境未安装 `pytest-cov` / `coverage`，本次未取得行/分支覆盖率数据；没有测试声明被删除，测试逻辑的覆盖证据保持原样。
- **Git / PR**：当前变更未提交、未推送、未创建 PR。上游 PR 目标按用户计划为 `Arsenal20262/LXE_AGENT`；之后由用户自行向 `LXE123/LXE_AGENT` 提交。下一模块应基于本分支形成 stacked PR；Review 串行进行。
- **下一步**：人工审阅本模块 diff 与真实产物；需要修改时仍在此分支修复。Commit、Push、PR 分别等待用户明确授权。
