# 马帮巴西海外仓签收筛选修正交接

## 当前状态

- Pool / Worktree：pool-4，`/Users/hym/PycharmProjects/LXE_AGENT/.worktrees/pool-4`
- 分支：`codex/mabang-brazil-overseas-export`
- Git：本次改动尚未暂存或提交。

## 本次完成内容

调拨签收数据的范围已经按最新业务口径固定为：

| 用户请求 | 马帮签收页实际筛选 | 输出 |
| --- | --- | --- |
| 三个月前已签收 | `type=2`、`allocationstatus=4`、`tablebase=2`、目标仓为巴西海外仓 | `马帮系统-已签收-巴西海外仓-北京时间.xls` |
| 三个月内待签收 | `type=2`、`allocationstatus=2`、`tablebase` 为空（马帮页面默认三个月） 、目标仓为巴西海外仓 | `马帮系统-3个月待签收-巴西海外仓-北京时间.xls` |

`tablebase=2` 来自马帮“仓库调拨签收”页面的“三个月前”快捷筛选源码，不再把已签收解释为全部历史记录，也不由本地自行计算日期。

导出链路会先请求当前筛选列表、从列表中动态提取单据 ID，再提交导出请求。不会写入用户手动抓取的样本 ID。

## 调用链

`自然语言请求` → `normalize_brazil_export_intent` → `export_brazil_overseas_allocation` → `warehouseallocation.searchallocation` → 动态提取单据 ID → `export.doAllocationWarehouseExportFile` → 下载马帮原始 XLS。

库存/销量请求继续走独立的库存导出链路，输出 XLSX。

## 风控与认证

- 仅使用已有 browser-auth 登录态；不自动登录、刷新或重试。
- 401、403、429 和导出异常立即停止。
- Cookie、令牌、账号和导出运行时参数不写入代码、文档或 Git。

## 验证

- 定向测试：36 passed。
- 真实导出：三个月前已签收 XLS、三个月内待签收 XLS、库存 XLSX 均已生成。
- 文件结构：两个调拨文件被系统识别为 OLE XLS；库存文件通过 ZIP 结构测试。

## 后续

1. 取得用户允许后，只暂存本任务相关文件并提交。
2. 提交后在当前 worktree 拉取并合并最新 `main`，仅检查和报告冲突；不修改其他 Pool 或分支。
