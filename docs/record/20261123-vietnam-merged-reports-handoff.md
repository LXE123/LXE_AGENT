# 越南独立库存与动销合并报表交接

## 范围与分支

- `codex/vietnam-merged-reports`，独立 Codex Worktree，无 Pool 编号；基线 `587dca72`（执行前从 upstream 获取 main）。
- 用户明确要求与菲律宾相同的独立两文件功能，与越南备货模板无关；批准对菲律宾流程做最小共享化。
- 本工作区含共享化和越南接入两层未暂存草稿。按用户规范，公共能力调整与越南接入须分层为 stacked PR：先评审共享层并保持菲律宾完整，随后基于其提交的下游层评审越南入口。现未创建下游分支、提交、推送或 PR；拆分及相应 Git 操作需按要求获批。

## 入口与结果

`lxeskill vietnam reports export [--resume-id <编号>]` → `services.commands.vietnam_reports.export_run` → `services.philippines_reports.workflow.export_reports(scope=VIETNAM)` → 雅仓 VN8806 库存动销和当前库存 → 马帮 TMS VN1 → 既有菲律宾合并及工作簿生成函数 → 校验后一起发布两个 XLSX。

两个文件分别为 `越南库存动销-YYYY年MM月DD日.xlsx` 和 `越南库存列表-YYYY年MM月DD日.xlsx`；第一张为雅仓原表（沿用雅仓库存动销交付时去除创建日期列的既有合同），第二张为菲律宾同规则的合并表。越南库存动销、库存列表或仓库数据请求按菲律宾入口规则交付两份；明确要求马帮 TMS 时单独导出。失败无交付文件；已有来源按原流程保存续跑编号。两国采用各自数据集、目录与续跑记录。没有备货计算或模板依赖。

## 文件与环境

- 共享能力：`python/lxeskill_cli/services/philippines_reports/{workflow,workbooks}.py`；菲律宾调用保持原默认配置。
- 越南入口与注册：`python/lxeskill_cli/services/commands/vietnam_reports/`、`python/lxeskill_cli/lxeskill/{catalog.json,business.py}`、`docs/lxeskill-cli/commands.md`。
- 指引：`skills/philippines-reports-export/SKILL.md`、`skills/yacang-reports-export/SKILL.md`、`skills/southeast-asia-replenishment-workflow-map/SKILL.md`。
- 测试：`python/lxeskill_cli/tests/philippines_reports/{conftest.py,test_vietnam_reports.py}`、`packages/agent/runtime/test/tooling/lxeskill-command.test.ts`；实施步骤在 `docs/superpowers/plans/2026-11-23-vietnam-merged-reports.md`。
- 沿用既有雅仓和 TMS 凭据、`LXE_DATA_ROOT`、`LXE_WORKSPACE_ROOT`、`LXE_SQLITE_DB_PATH`；无新增环境变量。新 Worktree 使用自己安装的 uv 和 Bun 依赖。

## 验证与限制

- Python：雅仓、TMS、菲律宾/越南报表、CLI 和 infra 回归 **786 passed、4 skipped**，4 条 aiohttp 弃用警告；在沙箱外仅使用本地模拟服务。之后增强原表逐格比对及错误/续跑测试，报表目录复跑 **55 passed**。
- Bun Agent 命令与 Skill 测试 **19 passed**；生成命令手册检查 up to date；独立只读评审提出的 Skill 命令指引错误及错仓、部分完成、跨国续跑测试建议均已处理。
- 两国来源并非同一时刻快照。真实雅仓/TMS、桌面自动路由和交付、Windows **NOT VERIFIED**；本轮没有生产取数或业务发送。
- 既有雅仓旧基线歧义问题是独立修复，当前 main 未纳入该修复；遇到它仍会停止，不能宣称本模块已解决。无强制代码依赖，但真实导出可能受该问题影响。

## Git 与下一步

当前全部修改和本交接均未暂存、提交、推送或创建 PR。先完成 diff、敏感信息、状态检查；向用户申请共享层的暂存和提交，随后按 stacked PR 顺序处理越南层。真实业务验收前不得将模拟测试称为真实取数成功。

## 2026-11-23 桌面测试与同步 main

- 用户反馈桌面测试通过；本次没有独立读取或复核真实导出结果，实际文件细节以用户测试为准。
- 经用户明确要求，先 fetch 和比对；`upstream/main` 从 `587dca72` 前进至 `a6cf2005`，仅更改一份上下文文档，与草稿路径无重叠，merge-tree 预检无冲突。随后将当前分支快进至 `a6cf2005`，未 stash、暂存或提交。同步前后核对 15 个草稿文件的 SHA-256 全部一致；后续仅补充本段交接。
- 本次未重跑测试：远端差异仅为文档。当前草稿继续等待按共享层、越南层拆分并分别审批 Git 操作。

## 2026-11-23 合并 Skill 与入口口径

- 用户确认菲律宾和越南使用一个 Skill，且越南库存动销、库存列表、雅仓越南库存与仓库数据请求均与菲律宾一样进入合并流程，交付两份报表。明确指定马帮 TMS 时仍走 TMS 独立导出；越南备货清单继续独立。
- 已将两国输入、仓库、命令与共同交付和合并规则写入原 `philippines-reports-export`；保留其内部标识以兼容菲律宾现有命令权限与统计，越南命令也归属该 Skill。删除本分支新建的重复越南 Skill，更新雅仓、TMS 与东南亚导航指引及命令测试。两个国家命令与共享业务程序不变。
- 合并前后模拟报表测试 55 passed，Agent 命令与 Skill 19 passed；命令契约及基础设施 425 passed、4 skipped，4 条 aiohttp 弃用警告。最新 Skill 入口在真实桌面对话中 **NOT VERIFIED**，用户此前的桌面测试通过仅覆盖修改前的独立 Skill。无新生产环境变量或第三方接口；未暂存、提交、推送或创建 PR。

## 2026-11-23 保留雅仓单独导出

- 用户强调按菲律宾全形式接入越南，退役重复部分但保留雅仓单独导出。复核确认菲律宾／越南共用原合并报表 Skill 和同一套业务程序；先前新建的重复越南 Skill 已删除。东南亚导航的两国重复条目合并，并在雅仓 Skill 明确记录单独导出命令仍保留。
- 雅仓单独导出命令、仓库合同及原始导出实现均未修改。新增通过真实 CLI、模拟 HTTP 的菲律宾 PH8805 和越南 VN8806 单独动销导出测试：各生成一张原表，不调用 TMS。合并报表及单独导出共 **57 passed**；Agent 命令与 Skill **19 passed**；`lxeskill doctor` 通过（51 个命令、36 个 Skill），命令手册为最新。
- 合并 Skill 改写后的真实桌面自然语言路由及真实 ERP 新取数 **NOT VERIFIED**；没有自动发起生产导出。Git 暂存区为空，未提交或推送。后续按共享能力与越南入口两层拆分，提交和 PR 操作需按约定分别获批。

## 2026-11-23 本次新增测试精简

- 用户要求将本次新增测试代码减少约一半。按之前的新增行数口径，测试从 138 行减至 72 行（新测试文件 60 行、Agent 命令测试新增 6 行、共享测试 fixture 新增 6 行），减少 66 行，约 48%。原有菲律宾测试保留。
- 越南保留真实 CLI 加模拟 HTTP 的两文件及原表／合并值／样式验证，以及菲律宾、越南雅仓单独导出。两国命令归属与续跑参数合并为一项 Agent 测试。共用流程的失败和续跑依靠已有菲律宾端到端测试。
- 越南独有的跨国续跑编号隔离、错误仓库拒绝、雅仓部分成功续跑和 TMS 429 后续跑，不再有独立越南测试；代码行为未改，不能声称这些越南专属情况仍由测试单独覆盖。
- `uv run --frozen --no-sync pytest python/lxeskill_cli/tests/philippines_reports -q`：53 passed；`bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`：6 passed。真实平台未重新运行；未暂存、提交或推送。

## 2026-11-23 提交分层

- 用户确认目标为 `Arsenal20262/LXE_AGENT` 并批准暂存及提交本次改动。共享程序作为第一层提交 `215333ec`；本层在其后接入越南命令、Skill、数据集和测试，拟按 stacked PR 顺序评审。
- 越南配置定义在越南命令入口；共享程序只保留菲律宾默认配置。第一层独立菲律宾报表回归 50 passed；本层提交前菲律宾／越南报表、CLI 和 infra 478 passed、4 skipped（4 条 aiohttp 警告），Agent 命令及 Skill 18 passed。
- 目标 `arsenal/main` 为 `548125d2`，相对当前基线 `a6cf2005` 缺 39 个上游提交；需先解决目标分支基线，避免 PR 混入上游改动。目标 main 同步、推送和 PR 均需分别获用户明确授权。桌面功能测试由用户反馈通过；真实平台和本轮单独环境未重复取数。
