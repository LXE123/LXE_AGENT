# 备货组合 SKU 官方接口接入验证

验证日期：2026-09-05。只读调用现有数据服务，未修改服务端或线上业务数据。

## 真实契约与原方案的差异

- 店铺响应中的 `name` 可以精确匹配 `Amazon-YYH-US`。**Listing 的 `shop_id` 必须使用店铺记录中的 `sid`**。这与数据服务仓库当前 `shop-list.md` 的描述不同：用对象键（该店铺与 `profile_id` 相同）请求，返回 58,850 条且首批混入其他店铺；用 `sid` 请求，返回 7,296 条，8 页全部通过店铺和站点检查。客户端不对这两个 ID 做猜测性回退。
- 店铺列表英国站点返回 `uk`，Listing 请求校验要求 `gb`，客户端显式统一为 `gb`。
- Listing 分页为 `data.list / total / nowPage / totalPage`。`shopIds` 可能带首尾逗号，必须只包含请求的 `sid`。`shopList` 缺失、null 或空数组时核验顶层 `amazonsite`；非空时核验唯一对应店铺的站点，详见下方德国站样本。
- `stockType` 实际返回整数，官方定义为 `1=库存 SKU、2=组合 SKU`。未配对记录的 `stockSku` 可能为 `null` 或空字符串；保留这类绑定供一致性检查，源表无本地 SKU 的行仍不参与库存查询。
- 组合分页实际为 `data.page / rowsPerPage / total / data`，不是原服务端模拟测试中的顶层分页。组件是 `comboProductDetail[].stockSku / quantity`。正常空结果为 `total=0, data=[]`。
- 按 SKU 搜索可能返回相似编号；匹配必须精确。已被 Listing 标记为组合但没有精确组合明细时，流程失败。

最小真实响应投影保存在 `python/lxeskill_cli/tests/mabang/fixtures/official_combo_contract.json`，只保留绑定、类型和组件等测试需要的字段，不保存凭据、成本、联系人或完整响应。

## 真实店铺验证结果

`Amazon-YYH-US`：

- 店铺查询 1 次；Listing 7,296 条，8 页，店铺解析和 Listing 阶段共 62.48 秒。
- 4,495 条记录有本地 SKU；去重后 3,829 个本地 SKU，包括普通 SKU 2,882 个、组合 SKU 947 个。
- 使用这次完整 Listing 的绑定构建验证输入，947 个组合明细全部成功，实际请求 947 次，耗时 198.89 秒。
- 两个阶段实际耗时之和约 261 秒，不含两个验证命令之间的间隔。相比逐项查询所有本地 SKU，跳过 2,882 次普通 SKU 的组合请求。
- 当前店铺映射与旧组合导出共有 623 个组合 SKU，逐项对照子 SKU 和捆绑数量，623 个全部一致。
- `HSP022` 的 8 个子 SKU 和捆绑数量与本地旧导出文件 `202606241445-Amazon-YYH-US_combo_sku.xlsx` 完全一致。

## 历史源表的限制

本地 `202607090944-Amazon-YYH-US_店铺MSKU数据.xlsx` 中，`YYHUSA575SKU04 / B0GWYZKVML / YYH575ZU04` 在当前 Listing 中未匹配。新流程明确报错并停止，不把实时绑定覆盖到历史销量源表。

因此，本次验证证明了当前店铺 Listing 的完整获取和全部组合明细查询，**不代表这份历史源表已经成功生成正式库存报表**。使用该历史数据前需重新下载 MSKU 数据。没有查询真实仓库库存，也没有生成正式报表；报表兼容性由固定源表、固定库存的回归测试验证。

## 维护注意

### 德国站的店铺明细与顶层站点（2026-09-10）

实际失败记录 `id=742854` 的请求为 `shop_id=["697456820"]`、`amazonsite=["de"]`。
响应的 `shopIds` 为 `,697456820`，顶层 `amazonsite` 为 `o5`，但唯一
`shopList` 条目明确返回 `shopId=697456820`、`amazonsite=de`。最小真实投影保存在
`python/lxeskill_cli/tests/mabang/fixtures/listing_de_shop_site.json`。

客户端使用对应店铺明细核验站点，不将 `o5` 映射为德国，也不按名称或商品链接猜测。
非空 `shopList` 必须只有一个有效条目且 ID、站点均与请求一致；异常、重复或其他店铺
均失败。顶层若是已公布的国家代码，仍必须与明细一致；未知或缺失顶层代码只在有效
明细存在时允许，并按页在 stderr 汇总代码及记录数。英国继续统一 `uk → gb`。

核验失败保留实际响应，区分店铺不符、明确站点冲突与站点信息不足。仅凭字段差异
不能判定马帮店铺配置错误。该样本本地 SKU 为空，通过站点检查后仍进入“无本地SKU”，
不自动参与备货计算。

同日独立实测还发现另一类真实返回：德国请求的第一页包含意大利店铺记录
`id=740615`、`shopIds=,697456822`、`shopName=Amazon-Lerxiuer-IT`、`shopList=[]`。
投影保存在 `python/lxeskill_cli/tests/mabang/fixtures/listing_de_cross_shop.json`。
这类数据仍按店铺不符拒绝；修复 `o5` 的站点识别不代表德国站完整备货已通过，
也不允许跳过跨店铺记录后发布不完整源表。

源表绑定必须与当前 Listing 一致。店铺不唯一、分页矛盾、类型或绑定冲突、组合明细缺失都停止处理；错误保留实际响应并脱敏、显式截断。仓库 Cookie 刷新只重试仓库阶段，不重新执行官方查询。
# Amazon.Found 缺失绑定的例外（2026-09-07）

真实库存入口允许 `Amazon.Found.*` 在当前 Listing 集合中完全不存在时继续执行。原行保留在“无库存数据”，库存为空，备注写明“SKU类型未核验，不参与备货计算”，不把缺失绑定当作普通 SKU，也不因销量为零就删掉源记录。

只有 MSKU 本身以前缀 `Amazon.Found.` 开始且完全没有该 MSKU 的绑定记录时适用。已存在记录但 ASIN 不符、绑定变化、重复定义冲突、类型错误仍然失败；其他 MSKU 的严格校验不变。已查到有效组合定义的 Found 记录照常计算。

内部调用必须通过 `unverified_found_rows` 收集未核验行，库存计算据此保留未知值；不接收这个集合的旧调用仍保持严格校验，避免把一个不完整的组合映射当作完整结果。普通已核验记录即使共享相同本地 SKU，也不受影响。只剩未核验 Found 行时，不请求仓库导出。

存在跳过记录时，CLI 成功结果增加 `skipped_amazon_found_msku_row_count`。四个 Sheet、原源表和备货公式不变，未核验行不进入下游读取的两个有效库存 Sheet。

真实验证使用 `202609071111-Amazon-YYH-US_店铺MSKU数据.xlsx` 和当前 Active Listing（1432 条、2 页）：两个 `Amazon.Found.*` 已跳过。但还有 703 行非 Found 的源记录未匹配，实际继续报错的首条为 `DP210514L01YHU220`。这项例外不解决 Active 查询范围与整个 MSKU 源表范围不一致的问题，也不能声称整店流程已通过。独立验证记录位于 `outputs/amazon-found-skip-20260907/validation.json`。
