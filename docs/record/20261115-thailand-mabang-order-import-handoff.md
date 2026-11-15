# 泰国马帮订单导入交接

## 工作区与范围

- 工作区：`.worktrees/pool-16`；分支：`codex/mabang-order-import-thailand`。基线是 PR #168 的头部 `34b270d9af9e54803d8c90ae31f8c43071895cb2`。
- 泰国复用公共订单导入流程：读取「泰国」工作表 E 列 SKU，使用 `TH` 前缀；按北京时间选全表最近日期，生成该日期的运输方式与批次，忽略旧日期标黄。模板及固定字段沿用公共资源。
- 用户另行要求：同一无年份表头可解释为两个与运行日等距的年份时，公共日期规则选择较晚的年份。六国共用该规则。
- 修改国家配置、公共日期解析、CLI catalog 和数据集登记、命令说明、业务 Skill、测试辅助与订单导入测试；本文件为交接记录。无新增环境变量。
- 调用链：`lxeskill mabang order-import generate --country thailand --input-xlsx <路径>` → `services.commands.mabang.order_import_generate` → `services.mabang.order_import.workflow` → `country_rules` → 公共读取及模板生成。数据集 ID 为 `mabang_thailand_order_import`。

## 验证

- 使用指定泰国备货表，按 2026-11-15 北京日期实际生成 A、B 两份文件；A 为 81 行、数量 2,970，B 为 489 行、数量 20,440。分别与用户提供的参考文件比较有效行全部 31 列，均一致。参考文件在有效行后有空白格式行。
- `uv run --frozen pytest python/lxeskill_cli/tests/mabang/test_mabang_order_import.py python/lxeskill_cli/tests/mabang/test_mabang_order_import_yellow.py python/lxeskill_cli/tests/mabang/test_mabang_order_import_regressions.py python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra`：552 passed、4 skipped；为允许测试监听本机回环端口，在沙箱外执行。初次沙箱内运行因端口权限失败。
- `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`：6 passed。用户反馈桌面测试通过。
- `git diff --check` 通过。未验证马帮系统中的实际导入及 Windows 端到端。

## 已知限制与下一步

- 同一无年份表头跨年等距时选择较晚年份，例如 2028-01-01 运行、表头为 `7/2陆运` 时选 2028-07-02；测试覆盖六国及泰国生成文件的订单号。
- 用户指定 PR #168 为目标；它现有头部分支位于 `Arsenal20262/LXE_AGENT:codex/fix-mabang-nearest-shipping-date`，主仓库 PR 仍为 open。提交和推送须按用户 Git 规范分别取得授权。
- 公共日期修复与泰国接入分别提交；本记录随泰国接入提交。尚未推送；推送须另行取得用户明确确认。保留其他工作区现状。
