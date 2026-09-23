# 马帮巴西海外仓调拨导出交接

## 当前状态

- Pool / Worktree：pool-4，/Users/hym/PycharmProjects/LXE_AGENT/.worktrees/pool-4
- 分支：codex/mabang-brazil-overseas-export
- 基线：本模块开始前已同步 origin/main，无合并提交或冲突。
- 本模块尚未提交；上一提交为 1a66816b feat: export Brazil overseas inventory workbook。

## 本次完成内容

新增 services.mabang.brazil_overseas.allocation，提供两种马帮分仓调拨原始 XLS 导出：

| 用户意图 | 查询状态 | 输出文件名 |
| --- | --- | --- |
| 三个月前已签收单据 | allocationstatus=4，tablebase=2，目标仓 1072376 | 马帮系统-已签收-巴西海外仓-YYYY-MM-DD_HHmm.xls |
| 三个月待签收单据 | allocationstatus=2，目标仓 1072376，日期保持空 | 马帮系统-3个月待签收-巴西海外仓-YYYY-MM-DD_HHmm.xls |

待签收的空日期值刻意保留，依赖已确认 ERP 页面默认的三个月范围；已签收使用页面确认的“三个月前”快捷筛选 `tablebase=2`，不自行计算日期。

调用顺序：

1. 使用现有 browser_auth_service 登录态，通过 build_private_amz_headers 取得 private-amz、private Cookie 与运行时 memcacheKey。
2. 在 erp_http_session 中 POST warehouseallocation.searchallocation。
3. 在同一 Session 中 POST export.doAllocationWarehouseExportFile，使用已抓包确认的 templateId=1058049、字段顺序与空 orderIds。
4. 仅接受 success=true 且存在 gourl 的响应；下载地址限定为 https://upload.mabangerp.com。
5. 下载内容必须是马帮返回的 OLE Compound File 格式 XLS，验证成功后才原子保存。

## 失败语义

- 401：认证错误，不自动刷新或重试。
- 403、429：立即停止，不重试。
- 筛选/导出业务失败、非 JSON、缺少 gourl、未批准下载域名、下载失败或无效 XLS：立即报错，不发布文件。

没有新增账号、Cookie、Token、环境变量或配置文件；memcacheKey 只从现有 Cookie 的运行时上下文读取，不写日志或提交。

## 修改文件

- python/lxeskill_cli/services/mabang/brazil_overseas/allocation.py
- python/lxeskill_cli/services/mabang/brazil_overseas/inventory.py
- python/lxeskill_cli/services/mabang/brazil_overseas/__init__.py
- python/lxeskill_cli/tests/mabang/test_brazil_overseas_allocation.py
- docs/superpowers/plans/2026-09-18-mabang-brazil-overseas-export.md
- 本交接文档

调拨导出单独验证 OLE XLS 签名并原子写入，库存导出继续使用独立的 XLSX ZIP 校验；两类格式不混用。

## 验证

已运行：

uv run pytest python/lxeskill_cli/tests/mabang/test_brazil_overseas_allocation.py python/lxeskill_cli/tests/mabang/test_brazil_overseas_inventory.py python/lxeskill_cli/tests/mabang/test_brazil_overseas_intent.py python/lxeskill_cli/tests/infra/test_dataset_registry.py

结果：93 passed。

所有测试使用伪造 Session、运行时 memcacheKey 占位值和本地 XLS 字节；没有调用马帮生产接口。

## 下一步

实现备货入口接入：

1. workflow 将自然语言意图分派到库存或两类调拨导出。
2. 新增现有 lxeskill Catalog 命令与 agent CLI 包装。
3. 在 replenishment-workflow-map 增加巴西海外仓路由，不改已有店铺 MSKU 补货流程。
4. 补充 Skill、标签、Catalog 文档和 Python/Bun 双端契约测试。

本模块提交后，按流程再次请求同步最新 main 并检查冲突。
