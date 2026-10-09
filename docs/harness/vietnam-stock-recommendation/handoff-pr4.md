# 越南备货在线 Workflow 与 Skill 交接

- 分支：`codex/vietnam-clean-pr4-online`；worktree 由 `scripts/wt-claim vietnam-clean-pr4-online` 领取。
- 基线：新 PR3 `f3145b1325de0986318d79d1f0c29ca9376a2f04`。
- 内容：新增 `lxeskill vietnam stock recommend` 在线一键入口、Vietnam Skill、命令 catalog 与输出数据集；Workflow 固定执行雅仓三类来源采集、SKU 参数读取、Workbook、Office 重算、结果校验和最终文件输出。原始雅仓报表请求仍归现有 `yacang export`。
- 文件：`config/skill-labels.json`；`docs/harness/skill/current_skill_catalog.md`、本交接页及 `docs/superpowers/specs/2026-10-03-vietnam-pr4-workflow-design.md`；`python/lxeskill_cli/lxeskill/{business.py,catalog.json}`、`services/agent_cli/vietnam_replenishment/{__init__.py,generate.py}`、`services/vietnam_replenishment/workflow.py`；对应 Python/Bun 测试；Vietnam、雅仓和东南亚路由 Skill 文档。
- 入口与顺序：Agent 选择 `vietnam stock recommend` → Python Workflow → 既有雅仓采集 → 来源整理 → 受信 SKU 参数 → 五表生成 → `shared.office` → 结果校验 → `output_xlsx`。不新增认证实现或环境变量；沿用雅仓配置与 Office Kit 环境。
- 验证：仓库根 Python 越南/雅仓模拟/CLI/catalog/infra 回归 599 passed、3 skipped；Bun catalog 与 Skill 23 passed；Runtime TypeScript typecheck 通过。前序 PR3 内部校验修正传播后，越南模块定向重跑 162 passed、1 skipped。测试使用合成数据与本机模拟服务，未调用雅仓生产接口。
- 已知边界：本层在线入口依赖 SKU current 有效；聊天附件绑定、Desktop 设置和稀疏 SKU 属于后续层。在线实际生产连通性未在本次重建中测试。用户明确提供已有三报表的离线入口由后续模块补充，不让本层跳过现有校验。
- 依赖与下一步：新 PR5 在此之上接 Desktop 受信版本与设置。仅本地提交，未 push 或创建新 PR。
