# 雅仓 XLSX 自动导出任务记忆（2026-09-13）

> 用途：作为 `codex/add-yacang-xlsx-export` 后续开发、Review 和交接的长期上下文。
> 本文只记录业务目标、已确认契约、当前状态和待补资料；禁止写入真实手机号、密码、Token、Cookie、Session、验证码、完整生产响应或 OSS 临时文件地址。

## 1. 最终验收目标

公司工作台用户可以直接向 Agent 下达自然语言任务：

- 导出四个仓原生 7/15/30 天销量，每仓合并为一份 XLSX；
- 导出四个仓 90 天销量，每仓拆成一份独立 XLSX；
- 导出四个仓的当前库存列表；仅当执行日就是目标月末时，它才代表该月末快照；
- 导出入库上架时间。

完整链路必须是：

```text
用户自然语言
  → Agent 意图识别
  → Skill discovery
  → 具体业务 Skill
  → Tool contract / lxeskill CLI
  → Yacang service
  → 验证码与登录
  → 导出任务提交
  → 队列关联与轮询
  → OSS 安全下载
  → 业务 XLSX 校验
  → Artifact
  → Agent 返回正确命名的文件
```

完成标准不是“Python 脚本可运行”或“单元测试通过”，而是上述链路在本地 mock 集成、经批准的单次受控生产验证和最终公司环境中均成立。

## 2. Git 与生产安全边界

- 工作分支：`codex/add-yacang-xlsx-export`
- 已有第一版 commit：`144f97e3c6d29a528361dbb7b0008186b2e2de02`
- 继续在当前独立 worktree 开发，不修改 `main`。
- 不 reset/amend/rebase/merge/push，不修改 global 或 repository Git config。
- 每轮先总结、展示关键 diff、扫描敏感信息、跑相关测试、展示 status，再等待人工批准 `git add`。
- `git add` 后展示 staged diff/status，再等待人工批准 commit。
- 永远不自动 push。
- 未经用户明确批准，不登录或调用真实雅仓生产接口。
- 首次真实验证只允许单业务、单仓、单次、串行、无自动重试。

## 3. 已确认的项目机制

### 3.1 Agent 与 Skill discovery

- Agent Runtime 递归发现仓库 `skills/**/SKILL.md`。
- repository Skill 优先于同名 user Skill。
- 当前 Skill frontmatter识别 `name`、`type`、`description`、`commands` 和 `references`。
- 当前没有 Skill 级 `alias`、`deprecated`、`replaced_by` 或 `hidden` manifest 字段。
- Skill 是否可用由 type 和运行时 `disabledNames` 等策略控制。
- `config/skill-labels.json` 只负责中文显示名，不负责身份、路由或兼容。

### 3.2 CLI 与 Tool contract

- `python/lxeskill_cli/lxeskill/catalog.json` 是 Python 与 Bun 共同消费的命令契约。
- `owner_skills` 决定命令可由哪些 Skill 激活。
- 多 owner 命令必须有 `attribution_skill`，单 owner 默认归属于该 owner。
- Skill frontmatter 声明的命令必须与 catalog canonical owner 一致。
- `legacy_aliases` 是旧 CLI 工具名兼容机制，不是 Skill alias。
- CLI 应保持薄层，不得重复实现登录、HTTP、轮询、下载或校验。

### 3.3 凭据与状态

- 继续使用 `LXE_YACANG_MOBILE` 和 `LXE_YACANG_PASSWORD`。
- 生产调用必须额外显式设置 `LXE_YACANG_PROD_ENABLED=true`；默认值和其他值一律关闭，不能因凭据存在而自动开启。
- Desktop 已负责安全保存并向进程注入，不需要在当前范围新增账号配置字段。
- Python 不读写 Bun Agent 会话数据库；它只在自己的 `lxeskill.sqlite3` 中维护雅仓非敏感风控状态和幂等标记。
- Token 只允许保存在单次客户端实例内存，不落盘、不进入结果或日志。
- 缓存只保存可丢弃的已校验产物，不保存认证信息或临时下载地址。
- Python CLI 数据库只额外保存非敏感的 429 cooldown、全局请求串行门禁和导出幂等标记；不保存 Token、Session、Cookie、手机号、密码、验证码或 OSS 地址。

## 4. 已确认的雅仓业务事实

### 4.1 固定仓库

| 仓库代码 | 内部 ID |
| --- | ---: |
| MY8801 | 26 |
| PH8805 | 46 |
| TH8802 | 47 |
| VN8806 | 80 |

仓库代码与 ID 是内部白名单，不允许 Agent 或 CLI 传任意 ID。

### 4.2 第一版库存动销流程

已确认存在以下业务步骤：

1. 获取图形验证码；
2. 使用手机号、密码、验证码和 key 登录；
3. 提交库存动销导出，参数包含创建日期范围和仓库 ID；
4. 查询导出下载队列；
5. 用新任务 ID、任务名、任务类型和仓库过滤条件关联任务；
6. 从队列任务取得下载字段；
7. 从受信任 OSS 主机下载 XLSX；
8. 校验文件后交付。

已确认库存动销原生 XLSX 表头：

```text
SKU, 商品名, 仓库, 3天销量, 7天销量, 15天销量, 30天销量,
60天销量, 90天销量, 库存, 占用, 在途, 冻结, 可用, 缺货数量, 创建日期
```

注意：原生表中是“15天销量”，不是“14天销量”。

## 5. 推荐的最终 Skill 与命令结构

采用“一个路由 Skill + 多个具体业务 Skill”，符合仓库现有 workflow-map 与具体 owner Skill 的组织方式。

建议 Skill：

- `yacang-export-workflow-map`：只路由，不直接执行；
- `yacang-sales-monthly-export`：7/15/30；
- `yacang-sales-90d-export`：固定近90天；
- `yacang-inventory-month-end-export`：当前库存列表；因远端接口无日期参数，禁止补导历史月末；
- `yacang-inbound-listing-time-export`：入库/上架时间；
- `yacang-inventory-sales-export`：是否继续独立发现取决于旧任意日期范围业务是否仍需保留。

建议 canonical CLI：

```text
lxeskill yacang export sales-monthly
lxeskill yacang export sales-90d
lxeskill yacang export inventory-month-end
lxeskill yacang export inbound-listing-time
```

现有 `lxeskill yacang inventory-sales export` 在没有确认等价迁移前不能伪装成新业务 alias。

## 6. 文件命名契约

集中管理业务显示名和文件名，禁止各业务重复硬编码。

分仓任务：

```text
业务名称_仓库代码_YYYY-MM-DD.xlsx
```

不分仓任务：

```text
业务名称_YYYY-MM-DD.xlsx
```

当前目标文件名：

- `雅仓系统-库存动销_MY8801_YYYY-MM-DD.xlsx`（同一文件包含7/15/30三列）
- `雅仓系统-库存动销-<仓库>_日度90天_YYYY-MM-DD.xlsx`
- `雅仓系统-库存列表_MY8801_YYYY-MM-DD.xlsx`（月末库存，分仓）
- `雅仓系统-产品-仓库产品_YYYY-MM-DD.xlsx`（入库/上架时间，不分仓）

7/15/30、日度90天、库存列表和仓库产品的文件名前缀、远端协议、队列形状和 XLSX 样例均已确认。

UI/Skill 中保留“入库/上架时间”，文件系统中移除 `/`。所有组成部分需要执行 Windows 非法字符、尾部空格/点号和保留设备名检查。

## 7. 当前未提交实现状态

当前 worktree 中存在一轮尚未暂存的试验性修改。它们不是已确认完成的最终实现。

### 7.1 已经实现或抽离

- 认证环境变量读取模块；
- 通用雅仓 HTTP Client；
- 错误脱敏扩展；
- OSS 下载安全模块；
- 四仓白名单；
- 队列轮询与仓库任务匹配；
- 串行提交、最小提交间隔和进程内去重；
- 库存动销 XLSX 校验；
- 集中业务名和 Windows 文件名；
- 旧库存动销实现拆入业务 exports 层，原模块保留兼容导入；
- 7/15/30 与日度90天命令、CLI、Skill、Tool contract 和 mock 测试；两类文件从同一批原始库存动销导出本地拆分；
- 库存列表当前快照的请求、队列匹配、固定 18 列校验、四仓/单仓导出、CLI、Skill 和 Tool contract；
- 仓库产品整体导出的请求、队列匹配、固定 11 列及“创建时间”格式校验、CLI、Skill 和 Tool contract；
- 雅仓路由 Skill，只路由到已确认协议的具体业务命令。

### 7.2 尚未实现或验收

- Agent → Skill → Tool → CLI → mock 的完整工作台集成验收；
- 经人工批准的单业务、单仓真实验证。

### 7.3 已识别并已修正到未暂存工作区

- `config/skill-labels.json` 只保留一个 `yacang-inventory-sales-export` 唯一 key，显示名为“雅仓库存动销导出”；兼容入口由 Skill 路由和 catalog `legacy_aliases` 表达，不依赖重复 key 或中文标签。
- 用户曾在雅仓页面手动选择14天日期范围并重新导出，结果仍然只有“15天销量”列，由此确认页面日期框不会生成14天销量。随后用户将最终需求调整为雅仓原生7/15/30，不再要求14天指标。
- 仓库产品队列没有请求 ID 或业务日期可关联，目前使用提交前基线、新任务 ID、任务名、类型和在售过滤条件匹配；所有真实请求增加了跨进程串行门禁，同一业务键另有持久化提交标记，仍按保守规则在无法确认时返回 `EXPORT_STATUS_UNKNOWN`，不猜测成功。
- 用户确认7/15/30合并输出：每个仓库生成1份 XLSX，同一个工作表包含7天、15天、30天销量列，四仓总计4份。
- 用户确认90天作为独立的“销量日度90天”产物，保留公共识别字段和对应的90天销量字段，不与7/15/30混在同一个交付文件中。该文件可从同一次下载的原始库存动销 XLSX 本地拆分，无需额外提交生产导出。
- 用户将另外两类产物命名为 `雅仓系统-库存列表_<仓库>_<日期>.xlsx` 和 `雅仓系统-产品-仓库产品_<日期>.xlsx`。
- 用户确认：未指定截止日期时以执行当天作为截止日，未指定创建日期范围时默认近7天；交付文件固定包含7/15/30三列，不再按单个销量周期拆文件。
- 真实访问增加显式生产开关，默认不触发验证码或登录；429 写入 15 分钟跨进程 cooldown，重启 Desktop/Gateway 不能绕过。
- 创建远端任务按副作用语义识别：即使接口是 GET 也从不自动重试；超时或连接中断返回 `EXPORT_SUBMIT_UNKNOWN` 并停止本批后续仓库。
- 队列空下载地址保持 pending；超时为 `EXPORT_POLL_TIMEOUT`，结构或匹配无法确认则为 `EXPORT_STATUS_UNKNOWN`。没有失败/取消真实样本前不引入猜测状态字段。
- 四仓局部下载、轮询或文件校验失败继续后仓并保留成功文件；认证、403、429、队列状态未知和提交结果未知会停止整批，后仓标记 `skipped`。

## 8. 可以直接继续开发的部分

以下工作不依赖未知生产协议，可在 mock/fixture 范围内继续：

1. 修正唯一中文 Skill label，不用标签表达兼容；
2. 增加原始 JSON 重复 key 检查，避免 `JSON.parse` 静默覆盖；
3. 强化公共下载失败清理、文件可打开和伪装错误页测试；
4. 强化公共脱敏测试，不写入真实值；
5. 完善串行、超时、去重、缓存和无自动重试测试；
6. 建立各业务适配器协议接口，但未知字段只保留抽象，不填猜测值；
7. 为未支持业务保留明确的失败关闭路由；
8. 建立 Agent/Skill/CLI mock 集成测试框架。

四类目标业务的协议资料已经补齐。后续只在完成本地集成验收后，等待用户明确批准一次受控生产验证。

## 9. 当前需要用户提供的资料

所有资料必须先删除或打码手机号、密码、Token、Authorization、Cookie、Session、验证码、验证码 key、用户标识和完整 OSS 临时地址。

### 9.1 销量月度7/15/30

已确认：

1. 使用已确认的库存动销远端导出协议；
2. 雅仓原始文件包含7天、15天、30天和90天销量字段；
3. 最终月度文件使用雅仓原生7/15/30，不再要求14天；
4. 每个仓库输出一份，同一工作表保留公共字段和7/15/30销量字段，总计4份；
5. 文件名为 `雅仓系统-库存动销_<仓库代码>_<YYYY-MM-DD>.xlsx`；
6. 用户未指定截止日期时使用执行当天；未指定创建日期范围时默认使用近7天；
7. 页面创建日期筛选只控制纳入哪些商品行，不改变销量统计窗口。

人工验证结论：手动选择14天创建日期范围后，文件仍只有15天销量，证明不能通过日期框生成14天指标。需求已经调整为7/15/30，因此该阻塞关闭。

### 9.2 销量日度90天

已确认：

1. 90天作为独立业务文件，不与7/15/30放在同一个交付文件中；
2. 数据直接来自同一次库存动销原始 XLSX 中的90天销量字段；
3. 每仓一次远端导出后，在本地同时生成7/15/30文件和90天文件，无需第二次生产提交；
4. 90天文件保留公共识别字段和对应90天销量字段；
5. 四个仓库各输出一份，总计4份。

当前实现约定：

1. 完整文件名为 `雅仓系统-库存动销-<仓库>_日度90天_<YYYY-MM-DD>.xlsx`；
2. 按“保留对应字段”解释为保留 SKU、商品名、仓库和90天销量，不伪造逐日明细，也不混入库存字段。

### 9.3 库存列表/当前库存快照

已确认：

1. 查询接口为 `GET /sys/customer/stockWarehouse/list`；
2. 导出接口为 `GET /sys/customer/stockWarehouse/export`；
3. 固定参数包含 `page=1`、`limit=10`、`goods_sku_condition=2`，仓库由白名单 `warehouse_id` 指定；
4. 导出提交响应表示任务进入下载队列；
5. 队列任务名为“库存导出”、`type=1`，`param_where` 是包含仓库和商品条件的对象；
6. 默认四仓各输出一份；用户可指定其中一个仓库，仓库代码严格受四仓白名单限制。文件名为 `雅仓系统-库存列表_<仓库>_<日期>.xlsx`；
7. 原生 XLSX 只有一个工作表，固定 18 列：条码、SKU、商品标签、映射条码、仓库、规格、尺寸(cm)、重量(g)、库存数量、占用数量、在途数量、冻结库存、可用库存、中文标题、英文标题、图片链接、退货处理方式、状态；
8. 接口没有日期参数，只能导出执行时的当前库存。不得将过去日期写入文件名并声称是历史月末快照；只有在目标日期当天执行才能留存该日快照。

截至当前未暂存工作区，已新增业务适配器、队列匹配、XLSX 校验、CLI、Tool contract、具体 Skill 和离线测试；尚未访问生产。

### 9.4 入库/上架时间

已确认：

1. 页面路径为雅仓 → 产品 → 仓库产品；
2. 导出接口为 `GET /sys/customer/sku/export`；
3. 固定参数为 `page=1`、`limit=10`、`status=1`、`goods_sku_condition=2`；
4. 队列任务名为“资料导出”、`type=6`，过滤条件包含在售状态，下载字段为 `path`；
5. 不接受仓库参数，一次输出包含全部在售仓库产品的一份文件；
6. 文件名为 `雅仓系统-产品-仓库产品_<日期>.xlsx`；
7. 原生 XLSX 只有一个工作表，固定 11 列：条码、SKU、规格、中文标题、英文标题、长、宽、高、重量、图片链接、创建时间；
8. 用户确认原生“创建时间”就是业务所需的入库/上架时间；真实样例中该列为无空值的 `YYYY-MM-DD HH:MM` 文本。

截至当前未暂存工作区，已新增业务适配器、非分仓风控、队列匹配、XLSX 校验、CLI、Tool contract、具体 Skill 和离线测试；尚未访问生产。

## 10. 抓包脱敏规则

可以保留：

- endpoint 路径；
- HTTP method；
- 非敏感 Query/Payload 字段名和值；
- HTTP 状态；
- 业务状态码和脱敏 message；
- 队列任务字段结构；
- 仓库代码或内部仓库 ID；
- XLSX 表头和伪造数据类型示例。

必须删除或替换成 `[REDACTED]`：

- 手机号、密码；
- `token`、`Authorization`；
- Cookie、PHPSESSID及其他 Session；
- 验证码、验证码图片和 key；
- 客户ID、用户ID等身份字段；
- OSS 完整对象路径和签名参数；
- 真实商品、客户或订单敏感数据。

不要再次发送真实账号密码；项目只需要协议结构和业务规则。

## 11. 下一步最小开发计划

### 阶段 A：先关闭当前可确认问题

1. 按用户最终确认将月度口径从7/14/30修正为雅仓原生7/15/30；
2. 修正 Skill label 和兼容表达；
3. 增加重复 JSON key 静态检查；
4. 将7/15/30合并文件和独立90天文件从同一次原始下载中本地生成；
5. 修正命令参数、Skill 文案、文件命名和测试；
6. 完成公共下载、脱敏、队列、限速、缓存的定向测试。

截至 2026-09-13，阶段 A 已完成到未暂存工作区：

- `sales-monthly` 固定生成四份 7/15/30 文件，不再接受 `range_days`；
- 新增 `sales-90d`，固定生成四份仅含公共识别字段和90天销量的文件；
- 两条命令共享每仓一份短期原始缓存，连续执行时总计只需四次远端导出；
- 队列任务同时核对新任务 ID、名称、类型、仓库、创建日期起止时间戳；
- 两类投影文件生成后再次校验唯一表头、单仓数据和行数；
- Skill、CLI、Tool Contract、中文标签和离线测试已同步；尚未 `git add`、`git commit` 或 `git push`。

### 阶段 B：逐业务接入真实契约

按资料完整度一次只接一个业务：

1. 库存列表（当前材料已补齐并完成离线实现）；
2. 入库/上架时间（材料已补齐并完成离线实现）。

每个业务都按以下顺序开发：

```text
脱敏协议 fixture
→ 业务 request/response model
→ 队列匹配器
→ XLSX validator
→ service workflow
→ thin CLI
→ catalog contract
→ concrete Skill
→ mock integration test
```

阶段 B 的两类协议均已完成离线实现。若未来新增雅仓业务，在资料不足时仍只保留抽象和失败关闭，不猜 endpoint 或字段。代码只能从运行时响应动态取得下载地址，不能记录样例中的真实 OSS URL。

### 阶段 C：完整本地验收

1. Python 定向测试；
2. catalog Python/Bun 双端契约测试；
3. Dashboard/Desktop/Gateway相关测试；
4. 从本地工作台发自然语言请求，通过 Agent → Skill → Tool → CLI → fixture 完成导出；
5. 检查 artifact 命名、数量、校验和错误脱敏。

### 阶段 D：受控生产验证

只有用户明确批准后执行。第一次只做一个已完成业务、一个仓库、一次提交，无重试、不并发，并人工观察请求频率、队列匹配、日志脱敏和最终 XLSX。

## 12. 每次恢复任务时的检查顺序

1. 阅读本文件；
2. 阅读仓库根 `AGENTS.md` 和用户提供的 `CODEX_RULES.md`；
3. 确认当前分支和 worktree；
4. 查看 `git status` 和未提交 diff，不覆盖用户改动；
5. 核对“当前需要用户提供的资料”是否已有补充；
6. 只开发已确认协议的业务；
7. 不访问生产、不执行 Git 写操作，除非用户在当前阶段明确批准。
