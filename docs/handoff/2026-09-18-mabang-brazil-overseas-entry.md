# 马帮巴西海外仓备货入口交接

## 当前状态

- Pool / Worktree：pool-4，/Users/hym/PycharmProjects/LXE_AGENT/.worktrees/pool-4
- 分支：codex/mabang-brazil-overseas-export
- 本模块尚未提交；上一提交为 d12c2586 feat: export Brazil overseas allocation workbooks。
- 本模块开始前已 fetch 并 merge origin/main；结果为 Already up to date，无冲突、无合并提交。

## 本次完成内容

三类巴西海外仓原始导出已接入现有补货入口，不创建新的平台入口。

公开命令：

lxeskill replenish brazil-overseas export --request-text "用户完整请求"

调用链：

1. agent CLI 读取 request_text。
2. workflow 使用固定中文意图规则判定库存/销量、已签收或三个月待签收。
3. 库存/销量调用 inventory 导出；已签收和待签收调用 allocation 导出。
4. Catalog 将 xlsx_path 作为唯一 deliverable，运行时从 terminal files 发送文件。

新增 Skill 为 replenishment-brazil-overseas-export，类型保持 amazon_replenish。replenishment-workflow-map 已将明确的巴西海外仓请求路由到该单步导出，禁止它进入 Amazon 店铺 MSKU 全流程或生成补货建议。

数据边界：

- 任何库存/销量表述都返回同一份原始库存 XLSX。
- 原始库存文件仅含累计 7/28/42 天销量，不虚构 7/15/30 或日度 90 天数据。
- 已签收返回页面“三个月前”快捷筛选中的已签收调拨单。
- 待签收保留空日期，使用 ERP 页面默认三个月范围。

## 认证与失败

- 不新增环境变量、账号、Cookie、Token 或 API Key。
- 使用既有 browser_auth_service、MABANG_ACCOUNT 和运行时 Cookie。
- 401、403、429、风控或导出不确定性立即停止；此入口不自动刷新登录态或重试。
- 成功才声明文件存在并由 Catalog 交付；失败保留真实异常。

## 修改文件

- python/lxeskill_cli/services/mabang/brazil_overseas/workflow.py
- python/lxeskill_cli/services/agent_cli/mabang/brazil_overseas_export.py
- python/lxeskill_cli/services/mabang/brazil_overseas/__init__.py
- python/lxeskill_cli/lxeskill/catalog.json
- skills/replenishment-brazil-overseas-export/SKILL.md
- skills/replenishment-workflow-map/SKILL.md
- config/skill-labels.json
- docs/harness/skill/current_skill_catalog.md
- packages/agent/runtime/test/tooling/lxeskill-command.test.ts
- packages/agent/runtime/test/tooling/skills.test.ts
- python/lxeskill_cli/tests/mabang/test_brazil_overseas_workflow.py
- python/lxeskill_cli/tests/mabang/test_brazil_overseas_export_cli.py
- python/lxeskill_cli/tests/lxeskill/test_lxeskill_cli.py
- docs/superpowers/plans/2026-09-18-mabang-brazil-overseas-export.md
- 本交接文档

## 验证

已通过：

- Python 相关测试：231 passed。
- Bun Catalog 与 Skill 发现测试：16 pass。
- bun run typecheck：全部 workspace 通过。
- 新命令 help 合同：已确认 command、owner skill、xlsx_path deliverable 和 request_text 输入。

未执行真实马帮接口调用或真实文件导出；生产验证仍需要用户明确授权并应使用最小样本、低频请求。

通用 Codex Skill 校验器只接受默认前言字段，因此拒绝本仓库既有的 type 和 commands 字段。该工具不适用于本仓库的 Skill 扩展格式；仓库自身的 Bun Skill 发现测试已通过。

## 下一步

本核心模块提交后，新开任务窗口继续：

1. 再次同步 origin/main，报告冲突或无冲突。
2. 做最终相关测试、typecheck、diff、状态和敏感信息复核。
3. 如获得单独授权，进行一次最小频率的真实马帮导出验证。
4. 输出最终合并说明；不自动 push。
