# Mabang 导出流水线试点评估（2026-07-14）

## 结论

本轮只将 `store_msku` 与 `msku_detail` 迁入即时 private-amz 导出流水线，停止继续迁移其余家族。两个试点共享的真实骨架是：获取鉴权材料、按 private-amz Cookie 查询导出 ID、按 private Cookie 与 memcache key 请求文件 URL、下载文件、执行域内转换。输入准备、文件命名、Excel 规范化、校验和结果 DTO 继续留在各域模块。

当前 `ExportPipelineSpec` 不提供轮询配置。两个试点都由导出请求直接返回 `gourl`，为它们预埋无人使用的轮询状态机会形成新的死接口。批次和轮询型导出应在有第三个真实消费者时设计独立骨架，不能扩宽当前即时导出契约来勉强容纳。

## L2a 共享 helper 边界

逐个比较实现后，只收敛了完全一致的实现：

- `configured_text`：六个本地定义，以及 `unlinked_shipments` 对 `batch_delivery` 私有别名的间接依赖；
- `clean_cell`：`msku_detail` 与 `stock_sku_export`；
- `clean_text`：八个完全一致的简单字符串清洗实现；
- `safe_store_msku_file_part`：`store_msku`、补货计算、销量分析三份相同的 ASCII 文件名实现；
- `request_headers` 与 `excel_suffix_from_url`：仅 `store_msku`、`msku_detail` 两个试点；
- private-amz/private Cookie header、必需 Cookie 与 memcache key 校验：仅两个试点。

以下实现有实际差异，因此保留在原模块：

- 六份 `resolve_output_dir` 使用不同配置键、默认目录或目录创建行为；
- `store_msku_actual_inventory.clean_text` 额外把 `nan` 视为空值；
- 其余 `safe_file_part` 在 Unicode 支持、非法字符集合和 fallback 名称上不同；
- `batch_delivery` 使用 Bearer token，`stock_sku_export` 与 `store_resolver` 的 request header 字段和配置来源也不同；
- 各域错误类继续保留原多继承层次，没有合并为公共异常。

## L2b 已迁移试点

### `store_msku`

输入先按原顺序规范化 `store_id`、`id_type`、`store_name`，随后进入即时导出流水线。下载文件名、xls 转换与删除、表头校验、`StoreMskuExcelResult.to_payload()` 字段保持不变。

### `msku_detail`

仍先校验 `ship_no`、解析或下载发货单、构造带店铺配对的 MSKU 来源，然后才获取鉴权材料。流水线完成文件下载后，域内逻辑继续负责 xls/xlsx 规范化、表头校验、店铺不一致 sheet 拆分、原始 xls 删除和 `MskuDetailExcelResult` 组装。

两个 resolver 继续抛各自的 `StoreMskuDownloadAuthError`、`MskuDetailDownloadAuthError`；两者仍同时属于域错误和 `MabangAuthError`，上层按鉴权错误重试的语义未改变。

## 不继续迁移的家族

- `stock_sku_export`：每批最多 3000 个 SKU，包含任务提交、状态轮询、多批文件与聚合结果；默认 timeout 180 秒、interval 3 秒。它不是即时单文件导出。
- `batch_delivery`：使用 freeToken/Bearer 鉴权，包含任务 hash、push/list/download 和状态轮询；默认 timeout 180 秒、interval 10 秒。鉴权与状态机均不匹配当前 spec。
- `unlinked_shipments`：先分页查询店铺和货件，再生成 snapshot，并复用批次发货任务能力；产物不是单个 ID 列表对应的即时导出。
- `store_msku_actual_inventory`：组合 SKU 与仓库库存走两套请求和文件处理链，最终还要匹配、合并多个输入文件；清洗和文件名规则也不同。
- `store_resolver`：核心是 HTML 解析、候选店铺消歧和本地工作簿，不是文件 URL 导出链。
- Amazon FBA/Restock snapshot、销量分析、补货计算和模板模块：都是本地数据转换，不属于远端导出流水线。

如果后续出现至少两个新的批次轮询消费者，应另建显式的 batch-task spec，并把 interval、timeout、状态解析和多文件聚合作为必填契约；不要给当前 `ExportPipelineSpec` 增加可选但无人使用的字段。

## 兼容性与验证

- `catalog.json`、`lxeskill` 命令、JSONL envelope、artifact 路径与 `to_payload()` 字段未改；
- aiohttp session 仍使用 `DummyCookieJar`，请求仍显式传递手工 Cookie header；新增回环测试验证 header 到服务端逐字保持；
- private-amz 的 `mabang_lite_rowsPerPage=100`、private 的 `exportv2=2`、必需 Cookie 和 memcache key 校验均保留；
- `stock_sku_export` 的 180/3 秒与 `batch_delivery` 的 180/10 秒轮询默认值未改；
- 相对 L2 开始前的 `d21296a`，`python/lxeskill_cli/services/mabang` 为 306 行新增、319 行删除，净减 13 行；
- 定向测试、完整 Python 套件与 `fba stock-sku download --delivery-no FBA123` 业务失败冒烟均通过。
