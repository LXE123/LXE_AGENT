# 智汇 TMS 菲律宾阶段 5 交接：CLI、Skill 与 Catalog

## 已接入

- 命令：`lxeskill tms philippines products-export`。
- 默认 `action=preview`：返回固定的菲律宾商品全量导出计划，不登录、不请求网络、不生成文件。
- `action=execute`：先检查 `ZHIHUI_TMS_PRODUCTION_ENABLED=1`、`ZHIHUI_TMS_ACCOUNT`、`ZHIHUI_TMS_PASSWORD`，然后串联登录、分页导出、下载和 XLSX 交付。
- 上述凭据由进程环境提供，不出现在 Catalog 输入字段、Skill 命令或返回结果中。Desktop 安全配置注入尚属阶段 6。
- “销量月度 7/14/30 天”“销量日度 90 天”“库存月末快照”“入库/上架时间”只归一化为同一商品导出；预览明确声明不提供独立历史指标。
- 每次执行使用独立产物目录；成功返回每页与合并文件的 `artifacts[]`。失败时仅返回真实存在的分页文件；分页数量未知时 `total_pages=null`。
- 跨进程锁阻止同一产物工作区内的并发智汇导出，锁冲突在登录前返回 `tms_export_busy`。
- Client 已有的 2 秒请求最小间隔、429 停止、登录/导出不自动重发，以及分页硬上限继续生效。

## 验证

从仓库根目录执行：

```text
UV_CACHE_DIR=/private/tmp/lxe-uv-cache uv run pytest python/lxeskill_cli/tests/zhihui_tms python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra -q
bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts
```

结果：Python `355 passed`；Bun `4 pass`。Python 测试中的 aiohttp 用例需要本机监听端口，沙箱外运行后通过。全部使用假 Client、假响应和本地临时文件，没有调用真实 TMS。

## 尚待阶段 6/7

- Desktop 的安全配置 UI、秘密存储与受控环境注入尚未接入，当前正式执行会因缺少开关/凭据而关闭。
- 尚未验证真实 API 的下载域名、Cookie、MIME 或登录响应；生产验收必须按阶段 7 的低频、小范围流程进行。
- 当前互斥锁按 artifact 工作区隔离；不同工作区如果使用同一个账号，仍需在 Desktop 账号层统一串行控制。
