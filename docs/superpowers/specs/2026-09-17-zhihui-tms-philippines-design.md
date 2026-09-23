# 智汇 TMS 菲律宾商品导出设计

## 目标

用户在 LXE Agent Desktop 中使用自然语言提出智汇 TMS 菲律宾商品数据需求时，系统统一执行智汇 TMS 的商品批量导出流程，按 1000 条/页导出全部商品，生成带页码和日期的 XLSX 文件，并额外生成一个合并后的总 XLSX 文件。

## 需求边界

当前智汇 TMS 只有菲律宾仓库，本阶段不实现仓库选择、写操作或多个报表接口。以下表达均作为同一个商品导出流程的自然语言入口：

- 销量月度 7/14/30 天
- 销量日度 90 天
- 库存月末快照
- 入库/上架时间

这些词语用于理解和回复用户，但不改变底层 API 的导出类型；不能把它们伪装成 TMS 已提供的独立历史报表。

## 已确认的外部 API 链路

1. `POST https://tms.mabangerp.com/tmsapi/login`
2. 校验 HTTP 200、`code == "200"` 和非空 `data.apiToken`。
3. 使用 `findMyStockwarehouseList`，固定 `pageSize=1000`，收集所有商品 `datas[*].id`。
4. 分页停止条件依次为：`datas` 为空、累计数量达到 `totalNum`、当前页数量小于 1000；不能只依赖 `pop.totalPage`。
5. 对每个页面的商品 ID 调用 `POST /tmsapi/exportStockwarehouse`。
6. 从成功响应的 `pop` 读取真实 XLS 下载地址并下载、校验和保存。

接口文档显示 `apiToken`、Cookie 和 Session 可能参与后续请求，但首次登录是否要求预登录 Token 尚未确认。实现必须先使用账号密码登录，只有真实响应明确要求时才引入预登录 Session/Cookie。

## 交付契约

每次任务使用同一个 `YYYYMMDD` 日期标签。分页文件命名为：

```text
智汇tms-商品-第1页-YYYYMMDD.xlsx
智汇tms-商品-第2页-YYYYMMDD.xlsx
```

合并文件命名为：

```text
智汇tms-商品-合并-YYYYMMDD.xlsx
```

每个分页文件和合并文件均作为独立 `artifacts[]` 返回。合并文件只保留一次表头并按分页顺序追加数据；分页文件保留真实分页结果，便于审计和排查。

## 架构

采用现有项目的 Python CLI + Skill + catalog 契约，不新增第二套 Agent 体系：

```text
Desktop natural language
  -> Skill discovery / routing
  -> deterministic intent normalization
  -> export plan
  -> Python CLI adapter
  -> Zhihui TMS Client
  -> paginated source fetch
  -> per-page export/download
  -> XLSX validation and merge
  -> canonical result with artifacts[]
```

职责边界：

- Skill：描述能力、标准命令、自然语言示例、澄清边界和结果读取方式；不拼 HTTP 参数。
- Intent：把用户表达归一化为一个固定的“菲律宾商品全量导出”意图；不推断接口不存在的历史数据。
- Planner：生成无副作用的导出计划，包括固定仓库语义、页大小、日期标签和输出策略。
- Executor / CLI adapter：消费计划并执行流程，不重新解释自然语言。
- Client：只负责认证、请求、响应校验、超时、限流和错误映射。
- Export service：负责分页、单页导出、下载、XLS/XLSX 文件检查、分页命名和合并。
- Result layer：返回每个真实文件的绝对路径、页码、总页数和状态；下载失败不得伪造成功。

## 安全与稳定性

- 凭据只从项目允许的运行时环境/配置边界读取；Token、Cookie、密码不进入日志、结果、Skill 或 Git。
- 所有外部请求必须设置明确 timeout；默认最多 3 次、指数退避和 jitter，仅对 408、429、5xx、短暂网络错误重试。
- 401、403、验证码、风控、账号异常和响应结构异常立即停止，不自动恢复。
- 分页设定 `max_pages`、`max_records`、`max_runtime` 和 `max_requests` 硬上限，防止异常接口造成无限请求。
- 检测页数据重复、页码不前进、`totalNum` 异常和商品 ID 缺失。
- 下载地址必须经过 HTTPS、可信域名、响应 MIME/文件头和文件大小检查；接口返回错误时保留真实脱敏错误语义。
- 文件合并失败时保留已下载分页文件并返回失败状态，不生成伪成功的合并文件。

## 阶段拆分

### 阶段 1：分析与契约

完成本文档、领域术语、接口 fixture 方案、目录与测试矩阵；不写业务实现。

### 阶段 2：Client 与认证

实现 TMS Client、登录 Session、timeout、错误映射、响应 schema 校验和脱敏日志；使用 fixture 测试，不触碰生产账号。

### 阶段 3：分页与单页导出

实现全量商品 ID 分页、批量导出请求、真实下载地址提取、分页文件保存和硬上限。

### 阶段 4：XLSX 校验与合并

实现 XLS/XLSX 读取校验、表头一致性检查、分页顺序合并、日期命名和 `artifacts[]` 结构。

### 阶段 5：Skill、Intent、Planner、Catalog

实现自然语言入口和确定性契约；更新 `catalog.json` 时同时运行 Python 与 Bun 两侧定向测试。

### 阶段 6：Desktop 联调

接入 Desktop Agent CLI 运行链路，验证自然语言请求、进度、错误展示和多个 Artifact 返回。

### 阶段 7：验收与最小生产 E2E

先完成完整源码验证，再由人工确认账号、范围和停止条件后进行低频、小范围生产验收。

## 不在本次范围内

- TMS 数据写入、库存修改、订单操作。
- 将销量 7/14/30 天或历史月末库存解释为接口真实提供的历史报表。
- 自动切换账号、代理轮换、验证码/风控绕过。
- Playwright、Puppeteer 或裸 CDP 页面级自动化。
- 强制生成 ZIP；分页 XLSX 和合并 XLSX 已足够满足交付。

## 验收标准

- Desktop 用户使用上述任一自然语言表达，均只路由到一个智汇 TMS 商品导出能力。
- 任务能够安全登录、拉取全部分页商品、逐页导出并下载。
- 每个分页文件名称包含正确页码和 `YYYYMMDD` 日期。
- 合并文件只有一个表头，数据按分页顺序完整追加。
- Desktop 返回多个分页 Artifact 及合并 Artifact，页码和总页数可识别。
- 任一认证、限流、风控、结构异常、下载或合并失败均保留真实错误语义并停止或部分失败，不伪造成功。
