# 马帮订单导入日期与数量修复交接

- **分支 / 工作区 / 基线**：`codex/mabang-order-import-date-quantity`、`.worktrees/pool-14`，基于 `origin/main@fbb3eab3`；原 PR #148 已合并，本修改独立于原 PR。
- **完成范围**：巴西、马来西亚、越南、菲律宾、印尼沿用按运输方式选择离当天最近日期及黄标批次的规则。每份文件的订单编号、交易编号和文件名使用所选列的日期；每份文件只包含该列数量大于 0 的非空 SKU，保持原顺序和重复项（用户已确认 0 不导出）。未选中旧列的年份歧义不阻止导出，选中列的年份歧义仍报错。选中列没有有效数量时生成仅有表头的文件；无对应运输表头时不生成该运输文件。
- **修改文件**：`python/lxeskill_cli/services/mabang/order_import/country_rules.py`、`workbook.py`，三个马帮订单导入测试文件，以及 `skills/mabang-order-import-generate/SKILL.md` 和本交接。旧测试因行为变化更新期望，未删除测试场景。
- **入口 / 调用链 / 环境变量**：`lxeskill mabang order-import generate` → `workflow` → `country_rules` / `source` → `workbook`；沿用现有配置和环境变量，无新增依赖。顶层 `sku_count` 仍取第一份文件，每个文件的计数见 `artifacts`。
- **业务样表验证**：使用用户本机 11/10 巴西备货表，固定北京时间业务日期为 2026-11-11，选中 BE 列 `11/10海运`，得到 `BR261110-H`、237 条 SKU、数量合计 46,710、空数量 0；导出 SKU 与数量按顺序和来源逐行相同。样表未纳入 Git。
- **自动化验证**：三个订单导入测试文件及 CLI / infra 联动测试合计 558 passed、4 skipped、4 warnings；覆盖五国未选中旧列的年份歧义、选中列年份歧义报错、跨年订单编号、数量筛选等场景。Bun 命令与 Skill 联动测试 18 passed。跨年针对性用例在修改前 6 failed、2 passed，修改后 8 passed。
- **边界 / 已知限制**：原截图对应的实际导出文件未找到，无法确认当时产生 11/9 数量的原因；现用同名原表复核 11/10 导出。颜色识别仍限定实心标准黄色；Windows 桌面附件端到端和实际导入马帮未验证。
- **PR 依赖 / Git 状态 / 下一步**：独立基于 main，无未合并 PR 依赖。根据用户授权，将 `.worktrees/pool-13` 未提交的跨年旧列歧义修复包含在本次修改中，旧工作区保留原状。实际提交状态以 `git status` 和 `git log` 为准；推送和创建 PR 按用户规范分别取得明确授权。
