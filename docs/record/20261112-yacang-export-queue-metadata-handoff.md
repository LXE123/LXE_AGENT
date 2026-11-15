# 雅仓导出队列元数据匹配修复交接

## 当前状态

- 工作区：`/Users/hym/Documents/ChatGPT/项目合并/LXE_AGENT-integration/.worktrees/pool-33`；分支：`codex/fix-yacang-queue-sorting`；基线：`1ef81bc7`。
- 目标仓库：`Arsenal20262/LXE_AGENT`，目标分支 `main`。GitHub 当前 `main` 为 `548125d2`，比本地基线多 11 个提交；这 11 个提交没有改动本次涉及的队列代码和测试，因此本分支不需要机械 rebase。
- 池 1–32 被占用，本次按 `wt-claim` 临时扩至 pool-33。

## 完成内容与调用链

- 调用链：`lxeskill yacang reports export` → `services.commands.yacang.export_run` → `services.yacang.workflow.run` → `queue.wait_for_file` → `queue.matches`。
- 队列匹配按报表类型识别已核实的平台元数据默认值：库存动销 `order_name=three_data`、`order_by=desc`；当前库存 `order_field=create_time`、`order_type=desc`、`stock_warehouse_list=1`。
- 未知筛选字段、未核实的元数据值、错误报表/仓库和多个匹配任务仍被拒绝。未更改请求参数、登录态、pending 数据或其他工作树。
- 修改文件：`python/lxeskill_cli/services/yacang/queue.py`、`python/lxeskill_cli/tests/yacang/test_export.py`、本交接文件。
- 没有新增环境变量。真实导出通过已运行的 LXE Agent 使用现有运行时配置及 `LXE_DATA_ROOT` / `LXE_SQLITE_DB_PATH`；未读取或输出凭据、登录态内容。

## 验证与真实导出

- 新增匹配用例在原实现上先失败；修复后相关 pending 恢复测试 **3 passed**。提交前重新执行 `uv run --frozen pytest python/lxeskill_cli/tests/yacang -q`：**85 passed in 28.38s**。本地模拟验证覆盖两类真实任务形状、pending 续跑不重复提交、错误元数据值和未知筛选拦截。
- 提交前 `git diff --check` 通过；提交状态以 Git 分支和对应 PR 为准。
- 经用户批准，通过补丁分支代码及现有运行时状态，恢复并下载 MY8801 库存动销 **3,581 行**、当前库存 **2,579 行**。结果文件生成于 2026-11-12 23:42；实际复用的平台任务创建时间分别为 23:12:49 和 23:26:11。本轮没有提交新任务，因此文件不是 23:42 的新鲜 ERP 快照。
- 2026-11-13 经用户授权通过现有服务新导出 VN8806、TH8802 的库存动销和当前库存，四项成功：TH 分别 **4,748**、**4,411 行**；VN 分别 **1,108**、**1,108 行**。界面重复运行了一次相同命令，生成了第二套行数相同的文件；数据验证结果相同，这次重复不属于代码改动。

## 已知限制与下一步

- 已核实的排序/模式元数据值来自 MY8801 实际任务；其他值保持拦截。2026-11-13 只读检查雅仓队列第一页（50 条）时，发现 VN8806、TH8802 库存及库存动销共 6 条记录，时间为 2026-11-09；这些记录没有额外元数据或未知筛选字段，当前匹配器均接受。未发起导出或修改状态。此抽样不证明后续新任务不会增加其他字段。
- 已核实的排序/模式元数据值来自 MY8801 实际任务；其他值保持拦截。若后续平台任务出现新的字段或取值，需先核验真实任务形状再扩展白名单。
- 本次没有修改 `malaysia-cli-registration` 分支上的未提交业务变更。
