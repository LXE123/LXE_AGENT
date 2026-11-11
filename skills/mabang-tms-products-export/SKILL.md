---
name: mabang-tms-products-export
description: 按现有固定筛选导出马帮 TMS 商品、库存和销量 XLSX，保留原字段并按同仓 SKU 汇总；全部仓库请求按实际仓库分别交付文件。指定 TMS 时，越南选 VN1、菲律宾选 PH1。菲律宾或雅仓菲律宾库存报表使用 philippines-reports-export；越南仓库数据来源不明时先确认 ERP，未指定 TMS 仓库先询问。
type: replenishment
commands:
  - lxeskill mabang-tms products export
---

需要查询 lxeskill 产物目录时，运行 `lxeskill datasets list`；返回的 `dir` 相对于当前环境的 `artifact_root`。

# 马帮 TMS 数据导出

## 业务范围

数据来自马帮 TMS 当前配置账号，沿用固定筛选 `status=1`、`isConfirm=1`、`gridproperty=-1`、`if_produce="-1"`、`stockQuantity=-1` 等，实际条件见结果 `filters`。代码未定义这些枚举的完整业务含义，不能据此保证覆盖全部商品或库存状态。支持菲律宾 PH1（仓库 ID 12107）、越南 VN1（仓库 ID 12831），或当前账号可见全部仓库；`all` 只扩大仓库范围，不取消固定筛选。本业务涉及 Shopee，但不按销售平台过滤。

用于用户要求导出 TMS 商品、当前库存、在途和累计销量，或为后续分析获取同一份仓库报表。每个仓库内按 SKU 汇总为一行，原表业务字段与机器人汇总结果放在同一张表中。`all` 保持当前账号可见全部仓库的范围，按实际仓库分别生成文件，不跨仓合并，也不根据仓库名称推测国家。命令完成取数和文件生成，不计算备货量；仅导出所选范围内接口返回的记录。

马帮 TMS 与马帮 ERP 是不同的取数系统，使用各自配置。仅凭“马帮”或“Shopee”不能唯一确定数据来源。

## 先确定系统与仓库

用户要求导出菲律宾或雅仓菲律宾的库存动销、库存列表或仓库数据时，使用 `philippines-reports-export`，合并雅仓 PH8805 与本 Skill 的 PH1 汇总产物并交付两份报表。明确要求马帮 TMS 时使用本 Skill 独立导出。

除上述菲律宾合并流程外，先使用当前请求或同一任务中已确认的 ERP 来源；来源未明确时，不能凭国家、Shopee 或其他任务最近使用的系统选择 ERP。

| 用户要求 | 执行选择 |
| --- | --- |
| 导出马帮 TMS 越南仓数据 | `--warehouse VN1` |
| 导出马帮 TMS 菲律宾仓数据 | `--warehouse PH1` |
| 导出马帮 TMS 全部仓库 | `--warehouse all`，各仓分别交付文件 |
| 导出马帮 TMS 数据，未指定仓库 | 先询问菲律宾 PH1、越南 VN1 或当前账号全部仓库；回答前不登录、不执行导出 |
| 导出马帮越南仓数据 | 同一任务已确认 TMS 时用 `--warehouse VN1`；已确认马帮 ERP 时按其对应 Skill 处理；仍无法区分时先询问马帮 ERP 还是马帮 TMS |
| 导出马帮菲律宾仓数据 | 同一任务已确认 TMS 时用 `--warehouse PH1`；已确认马帮 ERP 时按其对应 Skill 处理；仍无法区分时先询问马帮 ERP 还是马帮 TMS |
| 导出雅仓越南仓数据 | 使用 `yacang-reports-export`，选择 `VN8806`，不调用 TMS |
| 导出雅仓菲律宾仓数据 | 使用 `philippines-reports-export` 合并雅仓和 TMS |
| 导出越南仓数据，未指定 ERP | 先询问雅仓还是马帮 TMS；确认后分别选择 `VN8806` 或 `VN1` |
| 导出菲律宾仓数据，未指定 ERP | 使用 `philippines-reports-export` 合并雅仓和 TMS |

仅在来源已明确为马帮 TMS 后，明确越南或 VN1 时自动选择 VN1，明确菲律宾或 PH1 时自动选择 PH1，不重复询问已经明确的范围。只有用户明确要求全部仓库，或在询问中明确选择全部，才能传 `all`。未知仓库或冲突范围先澄清，不扩大为全仓。越南仓库来源未确定时复用 `southeast-asia-replenishment-workflow-map` 的 ERP 单选问题；仅称“马帮”时按上表区分马帮 ERP/TMS。若同时缺少仓库，先确认 ERP，再按对应 Skill 确认仓库。

桌面使用已有 `ask_user_question` 单选；该轮只提问，不并行调用导出。非桌面渠道用普通消息提问后等待回答。空答案、跳过或取消均不授权导出。可使用以下真实工具参数：

```json
{"questions":[{"id":"warehouse","question":"请选择马帮 TMS 导出仓库","multi_select":false,"options":[{"label":"菲律宾 PH1"},{"label":"越南 VN1"},{"label":"当前账号全部仓库"}]}]}
```

## 报表字段

商品、库存和销量在各仓的同一张报表中，沿用原表字段：

| 数据 | 已核实字段 |
| --- | --- |
| 商品与仓库 | 库存SKU、仓库、入库时间；同仓同 SKU 的原信息取最近入库的一整行 |
| 库存 | “库存量”“在途量”取最近入库原始记录的值；“可用库存”替换为同仓同 SKU 的列表 API `stockQuantity` 合计 |
| 销量 | 7天销量、15天销量、30天销量分别按列表 API 返回顺序取同仓同 SKU 的 `sale1`、`sale2`、`sale3` 首个非空值，不相加 |
| 金额 | 成本价、采购价 |

“可用库存”列不再使用原导出字段 `availableinventory` 的值。机器人汇总直接读取列表 API 的顶层 `stockSku`、`stockQuantity`、`sale1`、`sale2`、`sale3`；核对和汇总时去除 SKU 首尾空格，同仓相同 SKU 以首次出现顺序输出，交付的 SKU 也去除首尾空格。空白 SKU 无法识别商品，需报错。下载的 XLS/XLSX 明细行可能由一个 API 记录展开成多行，不能直接累加这些明细行来代替机器人计算。

库存和实际选用的销量须为有限数字；空值按 0 处理，负数保留。非空无效数字、布尔值、NaN 或无穷值会使汇总失败，并返回含字段和值的实际诊断。

列顺序沿用本轮原表，不额外增加一套机器人重复列。除“可用库存”和 7/15/30 天销量外，原字段统一取 XLS/XLSX 中该仓该 SKU 入库时间最新的一整行；例如“库存量”表示最新原始记录的库存量，总汇总量查看“可用库存”。有效入库时间优先于空时间，时间相同取首次出现的原始行；同组多条记录中出现无法识别的非空入库时间时，明确报错，不擅自选择一条。

商品名称不保证存在；其他销量窗口以实际表头为准并从最新原始行保留。销量是对应周期的累计量，不是逐日明细；入库时间未确认等于首次入库或商品上架时间。

## 命令、参数与前置条件

Agent 的业务入口只有 `lxeskill mabang-tms products export`，通过原生 `exec` 执行一条独立命令。catalog 中的 `mabang_tms_export_run` 是该命令的标识，不是另一个应直接调用的工具。

```bash
lxeskill mabang-tms products export --warehouse VN1
```

| `--warehouse` 值 | 适用范围 | 内部 `warehouseId` | 最终文件中的仓库名称 |
| --- | --- | --- | --- |
| `PH1` | 明确菲律宾仓 | `12107` | 菲律宾PH1仓 |
| `VN1` | 明确越南仓 | `12831` | 越南VN1仓 |
| `all` | 明确当前账号全部仓库 | 不传该字段 | 各文件使用数据中的实际仓库名称 |

`--warehouse` 只接受上述单个字符串，Agent 必须显式传入；无参调用仅保留非 Agent CLI 的历史全仓兼容，不能作为自然语言请求的默认选择。Agent scope 下漏传仓库会在登录前拒绝。此命令没有 `--report`、日期、SKU、页大小或自选字段参数；不要套用雅仓参数，也不要把 API 数字 ID 当作 CLI 仓库值。

账号密码来自桌面“马帮 TMS”配置，由环境注入；不通过命令传递凭据，不复用马帮 ERP、雅仓或紫鸟登录态。先确认来源与仓库，再调用命令；如果 `exec` 返回仍在运行，等待同一次执行结束，不因暂未生成附件重复启动。中间 `type=progress` 仅表示进度，最终 `type=result` 才用于判断交付结果。

## Workflow 内部接口与调用顺序

以下是 TMS 内部 HTTP 步骤，由同一命令自动编排，**不是 Agent 可单独调用的工具**，也不需要 Agent 另写 HTTP 或 Python 脚本：

| 内部步骤 | 用途与关键参数 | 结果如何用于下一步 |
| --- | --- | --- |
| `POST /login` | 用 TMS 配置的 `userName`、`pwd` 和本地 `local_time` 登录；每次任务登录一次 | 读取 `data.apiToken`，仅在本客户端内存复用于后续 TMS 请求，不交给用户 |
| `POST /findMyStockwarehouseList` | 分页查询本轮要导出的库存记录；`page` 从 1 递增，`pageSize=1000`，单仓传对应 `warehouseId`，all 不传；其他筛选固定沿用现有流程 | 读取 `datas` 与 `totalNum`，兼容顶层 `datas` 配合 `pop.totalNum`；校验记录身份和分页完整性，把本页顶层记录 `id` 交给导出步骤 |
| `POST /exportStockwarehouse` | 为当前已校验页面生成导出文件；`idsList` 为该页顶层记录 ID，仓库参数与查询相同，`pageSize=1000`，`stockValueArr` 为客户端既有固定字段 | 从响应 `pop` 或 `data.pop` 读取下载地址，尚不代表本地文件已生成或导出成功；实际字段请求可在结果 `requested_fields` 中查看 |
| GET 返回的下载地址 → 本地校验、汇总和发布 | 客户端下载平台文件；读取 XLS/XLSX，检查表头、SKU/仓库及记录行数覆盖，保存通过校验的原始批次 | 用通过校验的对应列表记录计算库存和 7/15/30 天销量，结合原表字段按同仓 SKU 生成一行；各仓独立生成 XLSX，CLI 将最终交付路径列入 `files`，Agent 再用 `send_files` 发送 |

查询和导出使用同一仓库 ID，导出记录 ID 来自目标列表的顶层 `id`。只以记录顶层 `warehouseId` 判断库存所属仓库，嵌套 `stock.warehouseId` 可能不同，不用于选仓。列表混仓或文件 SKU/仓库覆盖不符时停止，不改为全仓重试。

每页查询后立即导出、下载、校验，再查询下一页。完成依据是唯一顶层 ID 累计达到稳定 `totalNum` 且各批校验通过；短页不会提前结束，`pop.totalPage` 不能当作可靠总页数。重复 ID、总数变化、提前空页或超总数会失败；同 SKU 的不同 ID 保留。实际最多 100 页、10 万条、15 分钟，达到预算仍未完成时必须报告未完成。

## 结果判断与用户反馈

先检查最终 `ok`、`data.success`、`data.status` 和 `files`，不要用“有附件”或“计数相等”单独判断成功：

| 最终结果 | 识别方式 | 应如何反馈 |
| --- | --- | --- |
| 成功 | `ok=true`、`data.success=true`、`data.status=completed` | 说明选定范围、已导出记录数和文件；若总数为 0、`files=[]`，说明本轮无记录，不虚构附件 |
| 部分成功 | `ok=false`、`data.success=false`、`data.status=partial_success` | 仅交付 `files` 中此前已校验的部分，明确已导出/总数、剩余条数、失败页及实际错误，不称为完整导出；CLI 非零退出码不表示这些附件必须丢弃 |
| 失败 | `ok=false`，`data.status=failed`，或 CLI 在业务执行前拒绝参数/权限等 | 说明 `data.error` 或外层 `error` 的实际原因；无交付文件时不发送附件，不自行扩大仓库范围重试 |

结果中的关键字段均在 `data` 内：

- `warehouse`、`warehouse_id`、`warehouse_scope`、`filters`：本轮选择与实际筛选。单仓为 `selected_warehouse`；all 为 `current_account_all`、`warehouse_id=null`，不是“仅 PH1 与 VN1”的别名。
- `reported_total`、`read_unique_ids`、`exported_unique_ids`、`remaining_records`：接口报告总数、已读唯一记录、已校验导出记录及未导出数。未取得总数时 `reported_total` 和 `remaining_records` 可为 `null`；已读不代表已导出。
- `completed_batches`、`batches`、`failed_page`：已完成批次及失败位置；`failed_page` 仅失败时出现。`source_row_count` 是通过校验的原始 XLS/XLSX 数据行数，`row_count` 是汇总后的 Excel 数据行数，二者不能代替接口记录计数；同一 SKU 在不同仓库分别成行。
- `warehouses`、`headers`、`requested_fields`、`artifacts`：本轮通过校验数据涉及的仓库、实际表头、请求字段及最终文件元数据；各最终文件所属仓库以 `artifacts[].warehouse` 为准。

凭据缺失或登录失败时指向桌面“马帮 TMS”配置，不套用其他系统的 `lxeskill auth refresh`。列表瞬时错误由客户端有限重试；导出提交和下载不自动重试。401 检查登录/凭据，403/429 停止并反馈实际错误，不自行循环重试。

## 输出与附件交付

原始分批文件可能为 XLS 或 XLSX，保留作核验；默认交付 `files` 列出的最终 **XLSX**。每个实际仓库各有一份文件，原表字段和汇总值在同一张表中；文件名标明实际仓库，部分成功文件保留 `-部分导出` 标记。`all` 交付本轮各仓的全部最终文件，不把不同仓库或国家的数据合并成一份。附件名称与路径以命令返回值为准。

通过独立 `send_files` 发送返回的真实路径，附件名称沿用文件 basename，不根据 `artifacts.kind` 另起名称。文件生成与附件发送是两个步骤；发送失败只重试同一文件，不重新导出。

## 限制

- 当前命令仅支持上述仓库选择，不支持按销售平台或日期筛选，也不提供历史库存、逐日销量、独立上架报表、自选字段或备货计算。请求超出能力或来源不明确时，先说明限制并确认可接受的范围，不静默扩大导出范围。
- Excel 不含接口记录 ID，现有 SKU/仓库计数检查是覆盖下界，不能宣称已证明逐 ID 内容或精确展开行数。
- 结果中的仓库仅表示本轮数据涉及的仓库，不代表账号全部仓库清单。Shopee 业务背景也不代表已按平台过滤，不能据 SKU 或商品名称推断平台归属。
