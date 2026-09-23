# 智汇 TMS 菲律宾阶段 3 交接：分页与逐页导出

## 范围

本阶段在阶段 2 的 `services.zhihui_tms` Client 上实现：

- `findMyStockwarehouseList` 商品列表请求，固定 `pageSize=1000`。
- `exportStockwarehouse` 单页批量导出请求。
- 商品 ID 提取、分页停止条件和页面顺序保留。
- `max_pages`、`max_records`、`max_requests`、`max_runtime` 硬上限。
- 重复商品、totalNum 变化、页码不推进、无效商品 ID 和缺少 `pop` 的安全停止。

本阶段没有下载 XLS、校验文件、保存分页文件、合并 XLSX、实现 Skill、修改 Catalog 或接入 Desktop。

## 修改

- `python/lxeskill_cli/services/zhihui_tms/client.py`
  - 增加商品列表和逐页导出 endpoint 方法。
  - 请求体使用接口文档确认的字段，商品列表页大小固定为 1000。
- `python/lxeskill_cli/services/zhihui_tms/product_export.py`
  - 增加有界分页状态机和逐页导出编排。
  - 返回有序的 `ZhihuiTmsExportResult`；每个页面保留 `product_ids`、原始响应和 `pop`。
- `python/lxeskill_cli/services/zhihui_tms/__init__.py`
  - 暴露阶段 3 的分页结果、异常和入口。
- `python/lxeskill_cli/tests/zhihui_tms/`
  - 增加 endpoint payload、分页、停止条件、重复数据、硬上限和真实错误 fixture 测试。

## 关键决策

1. 不依赖 `pop.totalPage` 控制循环；依次依据空页、累计数量达到 `totalNum`、当前页小于 1000 条停止。
2. 空页是可验证的空结果，不发起导出请求；非空页严格一页对应一次 `exportStockwarehouse`。
3. 页码、商品 ID、totalNum 或 export `pop` 无法安全解释时立即停止，不猜测、不伪造成功。
4. 请求上限在每次外部请求前检查；运行时限制在请求前后检查，避免异常分页无限展开。
5. 当前只保留真实 `pop`，下一阶段负责 HTTPS 下载地址校验、文件头/MIME 检查和分页文件保存。

## 测试

从仓库根目录运行：

```text
UV_CACHE_DIR=/private/tmp/lxe-uv-cache uv run pytest python/lxeskill_cli/tests/zhihui_tms -q
```

结果：阶段 2 与阶段 3 合计 `28 passed`。

覆盖内容包括：

- 商品列表和导出 endpoint 的完整请求体。
- 1000 条分页、累计 totalNum、短页和空页停止。
- 同页/跨页重复商品、totalNum 变化、无效 ID、页码不推进。
- 缺少导出 `pop`、页数/记录数/请求数/运行时间上限。
- 认证、限流、网络错误、schema 错误的既有脱敏和停止语义。

## 风险与下一步

- 真实接口的 `pop` 下载 URL 尚未连接生产验证；阶段 4 必须先做 HTTPS、可信域名、响应 MIME/文件头和文件大小校验。
- 当前 Client/分页实现只在 fake Session 和 fixture 上测试，没有使用生产账号。
- 下一阶段实现分页文件保存、XLS/XLSX 校验、表头一致性检查、按页合并和 `artifacts[]` 结果。
- 仍不应把销量 7/14/30 天或历史库存解释为 TMS 独立历史报表。
