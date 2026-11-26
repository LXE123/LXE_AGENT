# 菲律宾报表共享能力交接

- 分支：`codex/vietnam-merged-reports`，独立 Worktree；基线 `a6cf2005`。本层将现有菲律宾报表编排与工作簿生成所用仓库、名称、产物目录参数化，菲律宾调用仍使用原默认值；合并公式、筛选、文件结构和续跑合同不变。
- 修改 `python/lxeskill_cli/services/philippines_reports/workflow.py` 与 `workbooks.py`。入口仍为 `lxeskill philippines reports export` → `services.commands.philippines_reports.export_run` → `workflow.export_reports` → 雅仓、马帮 TMS、`build_reports`。无新增环境变量，沿用既有雅仓/TMS 配置与应用数据目录。
- 工作区中越南入口、Skill、测试和主交接是下一层未暂存草稿，不属于本层提交。下游拟采用 stacked PR，必须先审本层；主线更新后按当时基线复核。目标 fork `arsenal/main` 目前为 `548125d2`，落后本分支基线，向其发 PR 前须处理基线差异并获相关 Git 操作授权。
- 从仓库根运行菲律宾报表目录回归及越南现有集成测试 53 passed；这些测试使用模拟 HTTP 和本地文件。用户此前报告桌面测试通过，但本层独立部署、真实 ERP 新取数与 Windows **NOT VERIFIED**。修改代码后再次检查 diff、`git diff --check`、状态和敏感信息。
- 本交接及本层两文件准备提交；其他草稿保留。下一步需分别获准处理下一层提交、目标仓库同步、push 和 PR。
