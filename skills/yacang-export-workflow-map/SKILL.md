---
name: yacang-export-workflow-map
description: 用户当前轮明确提到“雅仓/Yacang”，并查询销量、库存、入库或上架时使用的唯一雅仓导出入口。当前轮的雅仓平台词优先于历史 Context；不用于上马印尼、智汇/TMS、马帮巴西或 Amazon 补货。
type: replenishment
commands:
  - lxeskill yacang export run
---

# 雅仓数据导出路由

本 Skill 是 Agent 可发现的唯一雅仓导出入口，归入现有备货权限域，但业务范围仅限雅仓数据导出。Amazon/马帮店铺解析、补货计算和补货建议仍由各自的备货 Skill 处理。当前轮明确的平台、仓库、数据类型和时间高于历史 Context；只有用户说“刚才”“同上”“还是那个”时才继承缺失参数。只说“库存/销量/入库/上架”且没有平台或可继承上下文时必须澄清。模型必须先把用户话语翻译成下方定义的结构化意图，再调用唯一命令。

## 雅仓能力边界

- 完整库存动销 `inventory-sales`：销量、库存动销指同一份雅仓原始报表，含 SKU、商品名、仓库、3/7/15/30/60/90 天累计销量、库存、占用、在途、冻结、可用、缺货数量、创建日期，共 16 列。单仓交付经验证的原始 XLSX；多仓按固定仓库顺序合并为一个完整 XLSX。
- 当前库存 `inventory-current-snapshot`：按指定仓库或默认四仓导出当前库存；不能提供历史日期的库存快照。
- 仓库产品 `inbound-listing-time`：导出入库和上架时间，是全局任务，不按仓库过滤。即使用户带仓库词，也不把仓库参数传给该任务。
- “库存和销量/库存与销量”表示用户同时需要销量和当前库存，必须在一次结构化请求中选择 `inventory-sales` 与 `inventory-current-snapshot` 两类，并分别产出两类文件；不能把它们压成第四种数据类型，也不能只导出其中一类。
- 这三类是雅仓数据导出能力，不包含补货量计算、采购建议、其他平台的数据查询或不存在的 90 天逐日明细。

## 执行

```text
lxeskill yacang export run --data-type-intent '<JSON>' --warehouse-intent '<JSON>' --created-date-filter '<JSON>' --inventory-snapshot-intent '<JSON>'
```

- 正常调用必须传 `data_type_intent`、`warehouse_intent`、`created_date_filter` 和 `inventory_snapshot_intent` 四个结构化对象；只使用下方的 canonical 结构化参数。
- 每个意图必须是 `omitted`、`resolved` 或 `ambiguous`。无法确定时传 `ambiguous`，等待命令返回 `needs_clarification` 后把 `questions` 交给用户。
- `data_type_intent` 和 `warehouse_intent` 只要是 `resolved`，必须使用复数字段 `values`；即使只选一项也必须传数组，严禁传单数字段 `value`。
- `resolved` 的数据类型只能使用 `inventory-sales`、`inventory-current-snapshot`、`inbound-listing-time`；仓库只能使用 `MY8801`、`PH8805`、`TH8802`、`VN8806`。
- `created_date_filter` 的 `explicit_range` 必须由模型提供 `start_date` 和 `end_date`，格式为 `YYYY-MM-DD`；`relative_days` 只传正整数天数，代码负责换算实际日期。
- 用户没提商品创建日期时传 `{"state":"omitted"}`，命令复用统一默认：开始日和结束日都取执行当天。
- 用户没提仓库时传 `{"state":"omitted"}`，命令默认四仓 `MY8801`、`PH8805`、`TH8802`、`VN8806`；完全没提数据类型时默认三类。
- 单仓库库存/销量示例：`{"state":"resolved","values":["VN8806"]}`；多仓示例：`{"state":"resolved","values":["MY8801","VN8806"]}`。执行会按固定四仓顺序规范化选中项。
- 单独查入库/上架时，即使用户说了一仓或多仓，`warehouse_intent` 也传 `{"state":"omitted"}`；结果始终是只跑一次、覆盖四仓的全局文件。
- 同一请求混合库存/销量与入库/上架时，所选 `values` 只限制库存/销量；入库/上架仍只产生一份覆盖四仓的 global/all 文件。
- 禁止传 URL、headers、Token、Cookie、`task_type`、`param_where`、OSS 地址等底层参数。
- 旧调用兼容由内部适配层处理；新 Skill 路径不得依赖旧入口。
- 模型负责理解用户仓库语义，也可以直接输出 canonical warehouse code；parser/normalizer 必须具备相同的确定性 alias 归一能力和最终校验能力。归一映射固定为：马来西亚仓/马来西亚/马来仓/马来/MY → `MY8801`，菲律宾仓/菲律宾/菲仓/PH → `PH8805`，泰国仓/泰国/泰仓/TH → `TH8802`，越南仓/越南/越仓/VN → `VN8806`。职责边界是：模型负责理解，Schema 限制参数空间，normalizer 负责确定性归一，CLI 做最终校验；模型不得为了确认参数去查 fixture、parser 或 transcript。
- 分仓 XLSX 的最终文件名使用中文展示名（马来西亚仓、菲律宾仓、泰国仓、越南仓）；入库/上架时间是全局文件，不添加仓库名。
- 只要当前请求出现“四仓”“四个仓”“全部仓库”“所有仓库”或“全仓”，就按全部四个标准仓库处理；即使同时出现具体仓库，也由全部仓库优先，不返回范围冲突澄清。
- 返回 `overall_status=needs_clarification` 时，必须把 `questions` 交给用户确认，不得换用具体 Skill 猜测执行。
- “当前库存/现在库存/现有库存/还剩多少货”和未指定历史日期的“月底库存/月末库存/月末快照”都按当前库存列表执行；明确历史日期或历史月末库存返回不支持，绝不能用当前库存冒充。
- “最近卖得怎么样/最近销售情况”等没有明确业务对象的表达仍需澄清，不得猜测。
- 返回生产门禁错误时停止，不得开启门禁或改走兼容命令。

## 路由

| 用户需求 | 标准 data_type |
| --- | --- |
| 销量、7/15/30/60/90 天销量、月度销量、库存动销、动销数据 | `inventory-sales` |
| 库存、库存列表、未指定历史日期的月末快照、当前/现在/现有/目前库存、仓里还有多少、还剩多少货 | `inventory-current-snapshot` |
| 库存和销量、库存与销量、销量和库存 | `inventory-sales` + `inventory-current-snapshot` |
| 入库/入仓/进仓/上架时间、仓库产品 | `inbound-listing-time` |
| 全部数据、完整数据、全套 | 全部三类 |

## 自然语言样例

- “销量”“最近一个月销量”“90 天销量”“库存动销”“动销数据” → `inventory-sales`，都返回同一份完整原始结构，不按窗口裁字段。
- “库存和销量”“库存与销量”“销量和库存” → 同时选择 `inventory-sales` 与 `inventory-current-snapshot`，分别交付完整库存动销文件和当前库存文件。
- 历史销量输入由内部适配层统一归一为 `inventory-sales`；不能向用户描述为逐日数据。
- “56 天销量”“120 天销量”等非固定窗口 → 不支持，不生成新报表类型。
- “90 天逐日销量”“90 天每天销量”“日销量明细”“逐日销量”等明确要求逐日明细 → 不支持，不生成累计报表冒充逐日数据；90 天销量只是累计字段。
- “最近卖得怎么样”“最近销售情况”等不能确定业务对象的表达 → 追问是否需要完整库存动销报表。
- “库存”“库存列表”“月底库存”“月末库存”“月末快照”“当前库存”“目前库存”“现在仓里还有多少货”“当前剩多少” → `inventory-current-snapshot`。
- “8月31日库存”“上个月月底库存”“上月月末库存” → 当前能力不支持历史库存快照，不生成当前库存任务冒充结果。
- “MY8801、TH8802 当前库存”“马来和泰国当前库存” → 只执行对应仓库；“四仓库存” → 执行四个固定仓库。
- “MY8801 入库时间”“马来仓入库时间”“仓库产品”仍是单一全局 `inbound-listing-time`，仓库词不进入任务参数，也不因此返回失败。
- 对于需要按仓库执行的数据类型：单仓成功时，交付该 `data_type` 对应的经验证原始工作簿；多仓成功时，按固定仓库顺序合并为该 `data_type` 对应的单一工作簿。`inbound-listing-time` 仍是 `global/all`，只执行一次，不按仓库过滤。

Agent 只允许调用 frontmatter 声明的统一命令。类型级 CLI 仅用于旧调用兼容，不参与自然语言 Skill discovery；禁止自行尝试相似 endpoint、参数组合或生产探测，也不得改走其他雅仓命令冒充成功。

## 结果

- 只把最后一条 `type="result"` 记录作为 terminal；业务结果在 `data`，附件在 `files`。
- 当 terminal 为 `type="result"`、`ok=true` 且 `files` 非空时，视为当前雅仓任务已完成：只调用一次 `send_files(paths=<terminal.files>)`，然后结束；不要重新读取 Skill、fixture、parser 或 transcript，也不要再次调用雅仓 export。
- 当 terminal 表示部分成功时，保留并一次交付所有成功文件，同时根据 `overall_status`、`tasks`、`artifacts`、`questions` 和 `diagnostics` 报告失败/跳过的 `warehouse + data_type` 及真实且脱敏的错误，然后结束；不得因为单个仓库或数据类型失败而丢弃成功文件，也不得自动重跑整单。
- 只有没有可交付文件的真实失败，才按 terminal 中的 error/recovery 处理；上述字段用于业务摘要、失败说明和调试，不是正常成功路径继续调用工具的前置条件。
真实调用默认关闭。只有运行环境显式设置 `LXE_YACANG_PROD_ENABLED=true` 且凭据完整时，底层命令才允许获取验证码、登录、提交、轮询或下载；Agent 不得根据“检测到凭据”自行开启生产访问。遇到 403、429、认证异常、导出状态未知或提交结果不明确时，遵从命令返回的停止/跳过结果，不得自行重跑。
