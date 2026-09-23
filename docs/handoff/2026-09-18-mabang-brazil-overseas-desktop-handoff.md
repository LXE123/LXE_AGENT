# 马帮巴西海外仓导出交接

## 当前分支与提交

- Worktree：`/Users/hym/PycharmProjects/LXE_AGENT/.worktrees/pool-4`
- 分支：`codex/mabang-brazil-overseas-export`
- 最新提交：`0a22f1c5 fix: scope Brazil overseas allocation exports`
- 已同步并合并检查 `origin/main`；没有冲突。

## 已完成

1. 已接入现有“备货”业务入口，不新建独立平台入口。
2. 已实现巴西海外仓三类原始导出：
   - 库存/销量快照：`马帮系统-库存-巴西海外仓-YYYY-MM-DD_HHmm.xlsx`
   - 已签收调拨：`马帮系统-已签收-巴西海外仓-YYYY-MM-DD_HHmm.xls`
   - 三个月待签收调拨：`马帮系统-3个月待签收-巴西海外仓-YYYY-MM-DD_HHmm.xls`
3. 时间戳使用北京时间。
4. 调拨筛选已按确认后的马帮“仓库调拨签收”页面规则实现：
   - 已签收：`type=2`、`allocationstatus=4`、页面“三个月前”（`tablebase=2`）、目标仓为巴西海外仓。
   - 待签收：`type=2`、`allocationstatus=2`、页面默认三个月范围（`tablebase` 为空）、目标仓为巴西海外仓。
5. 调拨导出先查询列表并动态提取当前结果的 `orderIds`，不使用用户抓包里的随机样本 ID。
6. 外部调用只使用已存在登录态；不自动登录、不自动刷新、不无限重试。401、403、429 或风控信号立即停止。

## 文件与字段

### 库存/销量 XLSX

实际文件含 35 列，包括：`库存SKU编号`、`仓库`、`仓位`、`销量(7)`、`销量(28)`、`销量(42)`、`预测日销量(个)`、`仓位库存`、`可用库存量`、`最后出库时间`、`最后入库时间` 等。

当前马帮源文件实际只有 `销量(7)`、`销量(28)`、`销量(42)`；没有 15/30 或日度 90 天列。用户已确认“只要问销量就触发”该原始快照导出，不能虚构额外销量列。

### 两类调拨 XLS

两类 XLS 共用同一模板字段：`批次编号`、`签收日期`、`目标仓位`、`签收量`、`库存SKU`、`中文名称`、`重量`、`体积重`、`起始仓位`、`调拨数量`、`单价(RMB)`、`待签收数量`、`总入库数量`、`起始仓库`、`目标仓库`、`发货日期`、`预期到货日期`、`最近签收日期`。

`.xls` 必须保持马帮原始旧版 Excel 格式，不转换为 `.xlsx`。

## 已验证

- Python 定向测试：36 通过。
- Bun `lxeskill` 契约测试：4 通过。
- `git diff --check` 通过。
- 真实 API 已在已有登录态下成功产生三份原始导出文件；不含凭据。
- 最新 main 合并检查无冲突。

## 桌面端现状与下一步

1. pool-4 的 Electron 开发环境已能启动，Dashboard 和 Agent Runtime 均启动成功。
2. 桌面端当前仍缺云端下发的备货业务技能范围：`LXESKILL_SKILL_SCOPE` 为空时，CLI 返回 `skill_not_in_scope`，不会访问马帮接口。
3. 这不是马帮登录失败。需在客户端 Dashboard/云端设备权限为该设备下发 `amazon_replenish`（备货）权限；权限应在新的 turn 生效。
4. 获得权限后，在新的桌面对话测试以下三句，并检查每次产物以文件卡片交付：
   - `查询马帮巴西海外仓的库存`
   - `查询巴西海外仓已签收单据`
   - `查询巴西海外仓三个月待签收单据`
5. 模型先把原话解析为 `warehouse=brazil_overseas` 与 `export_kind` 枚举，再调用 CLI；Python 不解析自然语言。前端只交付原始文件，不改工作簿字段或文件名。每次请求当前只导出一种文件；三次请求应得到三张独立文件卡片。

## 关键路径

- 业务入口：`python/lxeskill_cli/services/agent_cli/mabang/brazil_overseas_export.py`
- 工作流：`python/lxeskill_cli/services/mabang/brazil_overseas/workflow.py`
- 调拨导出：`python/lxeskill_cli/services/mabang/brazil_overseas/allocation.py`
- 库存导出：`python/lxeskill_cli/services/mabang/brazil_overseas/inventory.py`
- 命名：`python/lxeskill_cli/services/mabang/brazil_overseas/naming.py`
- CLI 交付声明：`python/lxeskill_cli/lxeskill/catalog.json`
- 技能说明：`skills/replenishment-brazil-overseas-export/SKILL.md`

## 继续开发约束

- 不得使用 Chrome、裸 CDP、Playwright 或 Puppeteer 操作马帮页面。
- 不得硬编码或记录账号、密码、Cookie、Token、API Key。
- 不得修改 main、pool-3 或其他 worktree。
- 后续修改必须继续在 pool-4 分支；每个核心功能完成后：测试、`git diff --check`、补交接文档、经用户批准后再 `git add` / `git commit`。
- 不得 push，除非用户另行明确批准。
