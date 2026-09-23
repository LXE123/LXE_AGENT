# 马帮巴西海外仓认证风控加固交接

## 当前状态

- Pool / Worktree：pool-4，`/Users/hym/PycharmProjects/LXE_AGENT/.worktrees/pool-4`
- 分支：`codex/mabang-brazil-overseas-export`
- 基线功能提交：`e7252057 feat: add Brazil overseas replenishment export entry`
- 本次修改尚未提交。

## 本次完成内容

巴西海外仓的库存与调拨导出现在只读取已有的 `browser_auth_service` 登录态：

1. 新增 `get_existing_auth_context()`，只调用 `read_auth()`。
2. 状态缺失或不完整时直接返回认证错误；不调用 `ensure_auth()`、不刷新登录态、不重试。
3. 库存查询→导出和调拨查询→导出在单次工作流内各仅读取一次认证上下文，并复用该次读取的 Cookie 请求头。
4. 其他马帮模块仍使用原有 `get_auth_context()`，其自动恢复行为未改变。

## 修改文件

- `python/lxeskill_cli/services/mabang/auth.py`
- `python/lxeskill_cli/services/mabang/brazil_overseas/inventory.py`
- `python/lxeskill_cli/services/mabang/brazil_overseas/allocation.py`
- `python/lxeskill_cli/tests/mabang/test_mabang_auth.py`
- `python/lxeskill_cli/tests/mabang/test_brazil_overseas_inventory.py`
- `python/lxeskill_cli/tests/mabang/test_brazil_overseas_allocation.py`

## 验证

已执行本地 fake-session 定向测试：

```text
uv run pytest python/lxeskill_cli/tests/mabang/test_mabang_auth.py \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_inventory.py \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_allocation.py \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_workflow.py \
  python/lxeskill_cli/tests/mabang/test_brazil_overseas_export_cli.py

29 passed
```

未执行真实马帮 API 请求、登录或导出。

## 入口与失败行为

入口不变：

```text
lxeskill replenish brazil-overseas export --request-text "<用户请求>"
```

- 认证状态不存在：立即失败并提示读取现有登录态失败。
- 401、403、429、风控或无效 XLSX：立即停止，不重试。
- 只有用户单独授权后，才可以做一次最小频率的真实环境验证。

## 下一步

1. 用户批准后仅 stage 并 commit 本次六个代码/测试文件与本交接文档。
2. commit 后同步最新 `origin/main`，如有冲突立即报告。
3. 获得明确生产授权后，低频执行一次真实导出验证；不自动登录、不推送。
