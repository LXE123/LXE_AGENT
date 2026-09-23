# 智汇 TMS 请求预算与本地贯通验收

## 本次加固

- Client 对每一次实际 HTTP 尝试计数，包含重试和文件下载；默认总上限 400 次，达到上限时在发送前停止。
- 正式 CLI 返回逻辑列表/导出请求数 `request_count` 与实际 HTTP 尝试数 `http_attempt_count`，便于核对风控预算。
- Desktop 提供 `LXE_DATA_ROOT` 时，同一智汇账号在不同工作区使用同一个跨进程锁；锁文件名是账号 SHA-256 摘要，不含明文账号。独立 CLI 没有该数据根时回退到当前 artifact 工作区。
- 账号锁冲突在登录前停止，不等待、不再次发起导出。

## 本地贯通测试

使用假登录、假分页商品响应、假导出链接和本地生成的 XLSX，从正式 `lxeskill tms philippines products-export --action execute` 入口走完整条链路。验证了 4 次实际 HTTP 调用、分页 XLSX 与合并 XLSX 两个附件、合并数据行和下载请求不携带 Token Header。

验证命令：

```text
UV_CACHE_DIR=/private/tmp/lxe-uv-cache uv run pytest python/lxeskill_cli/tests/zhihui_tms -q
```

## 生产验收前的边界

- 当前固定 2 秒请求最小间隔、429 立即停止、登录和导出不自动重发、HTTP 尝试上限是保守保护，但不能代替智汇官方的实际频率政策。
- 尚未使用真实账号确认登录、导出文件地址、响应格式和 Cookie 行为；生产端到端结果仍待人工授权的低频验收。
- 同账号互斥依赖 Desktop 共用的 `LXE_DATA_ROOT`；脱离 Desktop 且分属不同本地工作区的独立 CLI 进程不能共享此锁。
