# 菲律宾库存报表交接

## 当前范围

- PR #153 基于 main `a059b78c` 整理，依赖的雅仓统一登录入口和 TMS 分仓 SKU 汇总已分别通过 #151、#152 合入 main。
- 命令 `lxeskill philippines reports export` 自动获取雅仓 PH8805 库存动销、当前库存及 TMS PH1 汇总，交付两份合并 XLSX。
- 冲突解决保留 main 的五国订单导入、统一雅仓登录和已清理的 TMS/雅仓测试。菲律宾默认合并路由按维护者确认保留。

## 业务规则

- 菲律宾或雅仓菲律宾库存动销、库存列表及仓库数据默认生成两份合并报表。明确要求 TMS 时独立导出；创建日期筛选和多仓需求先确认范围。
- 动销只相加 7、15、30 天销量和可用库存；库存表只相加可用库存，其余字段保留雅仓值。TMS 独有 SKU 没有来源的字段留空。
- SKU 区分大小写、保留前导零，去除首尾空格后匹配。重复 SKU、公式、Excel 错误和无效数值报错，合并数值使用 Decimal 计算。
- 先合并再过滤：动销的 7/15/30 天销量全部为零时过滤；库存可用量为零时过滤。空值按零处理，非零负数保留。
- 两份文件为“菲律宾库存动销”和“菲律宾库存列表”，日期固定为任务开始时的 Asia/Shanghai 日期。每份第一张表保留雅仓原表、格式和富文本，第二张表写合并结果。
- 任一来源失败或部分成功时，不交付合并报表。仅当 TMS 完整成功且确认 PH1 无记录时允许只含雅仓的数据。
- 失败返回的 `resume_id` 用于 `--resume-id`，复用已完成的雅仓来源，完成后清除进度。两系统不保证同一时刻快照，不计算备货建议。

## 调用与数据

- `services/commands/philippines_reports/export_run.py` → `workflow.export_reports` → 雅仓导出 → TMS 导出 → `build_reports` → 成对发布。
- 命令与数据集由 lxeskillCLI catalog 管理；数据集 ID 为 `philippines_reports`，目录为 `philippines/reports`。来源 SHA-256、行数与最终交付文件保留在返回结果中。
- 凭据沿用现有雅仓和 TMS 配置。业务进度、SQLite 和文件归 lxeskillCLI 所有；无新增 Electron/agentcli 生产实现依赖。

## 2026-11-11 测试整理与修复

- 菲律宾流程测试改为只模拟 HTTP 传输，真实执行两个客户端、两个上游 workflow、雅仓登录态/SQLite、来源校验、工作簿生成及 CLI 文件交付。系统时钟单独隔离，内部 workflow、合并函数和 CLI 执行函数不再 Mock。
- 删除命令/schema/字段映射复读断言，改测实际权限拒绝、合并数值、过滤、脱敏、失败时无附件、续跑不重复取数以及进度清理。数值用例覆盖空值、零、负数、小数、NaN、Infinity 和布尔值。
- 真实链路发现 TMS 写入的 XLSX 末尾空列会被省略，读取器因此误报行宽不一致。读取时按表头补齐末尾空单元格，仍拒绝超出表头的行；两个真实工作簿往返回归在修复前失败、修复后通过。
- 第二份工作簿保存失败使用真实目录占位触发，验证错误、源文件和已有目标保留。该用例直接覆盖工作簿构建函数，不声称模拟了外层发布中的任意系统故障。
- agentcli 通过真实 CLI 查询新增命令归属，验证首次导出和带续跑参数的调用都记入菲律宾 Skill。

## 实际验证

从仓库根目录执行：

- `uv run --frozen pytest python/lxeskill_cli/tests/philippines_reports python/lxeskill_cli/tests/mabang_tms python/lxeskill_cli/tests/yacang python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra --tb=short`：779 passed、4 skipped（Windows 专属）。
- `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts packages/agent/runtime/test/tooling/skills.test.ts`：18 passed。
- `uv run --frozen python scripts/generate-lxeskill-command-docs.py`：手册已同步。

以上使用合成 HTTP 响应和真实临时文件、SQLite，没有访问真实 ERP。真实验证码识读、生产取数和 Windows 端到端未验证。

## 维护者已接受的边界

本轮保留既有行为：续跑记录未绑定来源账号；菲律宾文件读取层未额外严格核对必要列和实际雅仓仓库，正常自动取数依赖上游导出的校验。维护者明确接受这两个边界，本次没有将其标记为已修复。

## 2026-11-12 合并表样式

- `codex/fix-mabang-nearest-shipping-date`：两份合并表按字段沿用各自雅仓原表的单元格样式、列宽、行高和视图设置。雅仓商品使用对应原行样式；TMS 独有商品使用雅仓首条数据行样式，无数据行时使用默认样式。合并与筛选规则不变。
- 修改 `services/philippines_reports/workbooks.py`、对应工作簿测试和菲律宾 Skill。调用入口、凭据和数据归属不变；菲律宾基础功能已通过 #153 合入 main。
- 当前工作区运行 `uv run --frozen --no-sync pytest python/lxeskill_cli/tests/philippines_reports -q --tb=short`：50 passed。依赖同步因网络不可用未完成，本次使用已有工作区环境。
- 曾用本地雅仓历史动销文件和 13 列库存旧样本生成仅供样式预览的两份报表；未取得实时 TMS 数据，不能作为完整来源验收。真实平台导出和 Windows 显示效果仍为 NOT VERIFIED。
- 工作区保留既有未跟踪的 `docs/superpowers/plans/2026-11-05-philippines-reports.md`；提交及后续推送状态以 Git 和远端为准。
