# 马帮巴西海外仓库存导出交接

## 当前状态

- Pool / Worktree：pool-4，/Users/hym/PycharmProjects/LXE_AGENT/.worktrees/pool-4
- 分支：codex/mabang-brazil-overseas-export
- 本模块尚未提交；上一提交为 83f1ca91 feat: add Brazil overseas export intent
- 已同步 origin/main：无需合并提交，工作基线未变化。

## 本次完成内容

新增 services.mabang.brazil_overseas.inventory，用于库存、销量、库存快照类巴西海外仓请求共用的原始 XLSX 导出。

调用顺序是固定的：

1. 从已有 browser_auth_service 登录态读取 private-amz.mabangerp.com Cookie。
2. 在同一个 erp_http_session 中 POST warehouse.searchwarehousestock，其中 warehouseIdArr=1072376、isIdn=1。
3. 使用同一个 Session GET 固定库存导出地址，不在导出 URL 中添加仓库 ID。
4. 验证下载内容是完整 XLSX ZIP 工作簿，再原子写入数据集目录。

输出文件名使用北京时间：

马帮系统-库存-巴西海外仓-YYYY-MM-DD_HHmm.xlsx

返回结果明确声明这是平台原始导出，销量字段仅为累计 7/28/42 天；没有虚构 7/15/30 或日度 90 天数据。

## 失败语义

- 401：返回明确的认证错误，不自动刷新或重试。
- 403、429：立即停止，不重试。
- 筛选业务失败、HTML/空响应、损坏 ZIP、非 XLSX 工作簿：不写出文件并报错。

没有新增账号、Cookie、Token 或其他配置项；继续使用既有 Mabang 登录态和配置注入。

## 修改文件

- python/lxeskill_cli/services/mabang/brazil_overseas/inventory.py
- python/lxeskill_cli/services/mabang/brazil_overseas/__init__.py
- python/lxeskill_cli/tests/mabang/test_brazil_overseas_inventory.py
- docs/superpowers/plans/2026-09-18-mabang-brazil-overseas-export.md
- 本交接文档

## 验证

已运行：

uv run pytest python/lxeskill_cli/tests/mabang/test_brazil_overseas_inventory.py python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py python/lxeskill_cli/tests/infra/test_dataset_registry.py

结果：85 passed。

测试使用伪造 Session 与 XLSX 字节，没有请求马帮生产接口。

Worktree 从 pool-3 迁到 pool-4 后，发现本地 .venv/bin/pytest 的 shebang 仍指向旧 pool-3 路径；已通过 uv sync --frozen --reinstall 在 pool-4 重建锁定依赖。该修复只影响未纳入 Git 的本地虚拟环境。

## 下一步

实现 services.mabang.brazil_overseas.allocation：

- 已签收：allocationstatus=4，tablebase=2，巴西目标仓，即页面“三个月前”快捷筛选。
- 待签收：allocationstatus=2，巴西目标仓，保留空日期以使用页面默认三个月范围。
- 使用已确认导出模板和运行时 Cookie 中的 memcacheKey，验证 gourl 下载的 XLSX。

提交本模块后，再按约定请求同步最新 main 并检查冲突。
