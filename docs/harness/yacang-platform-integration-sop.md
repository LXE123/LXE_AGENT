# 雅仓平台接入与交付 SOP

本文沉淀当前雅仓模块的接入方式，供后续接入马帮、印尼、菲律宾等平台时复用。它定义的是接入边界、交付流程和验收口径；具体平台的字段、接口和权限仍应以该平台的真实能力为准。

## 1. 先确认业务合同，再开始开发

接入一个新平台前，先把以下内容写清楚并由业务确认：

- 用户可以怎样用自然语言表达需求；哪些表达需要追问，哪些表达明确不支持。
- 平台实际可导出的报表、字段、日期范围和仓库范围。不能把累计字段包装成日明细，也不能凭空生成平台没有的数据。
- 每类报表的真实副作用：是否登录、是否提交导出、是否轮询、是否下载文件。
- 单仓、多仓、全仓的结果形态，以及单个仓失败时是否允许其他仓继续。
- 文件必须保留的原始字段、文件名规则、交付位置和业务可见提示。

雅仓当前已确认的能力如下：

| 业务能力 | 正式 canonical 类型 | 结果 |
| --- | --- | --- |
| 完整库存动销 | `inventory-sales` | 原始完整库存动销 XLSX |
| 当前库存 | `inventory-current-snapshot` | 当前库存 XLSX |
| 入库 / 上架时间 | `inbound-listing-time` | 全局 XLSX，不分仓 |

`sales-monthly`、`sales-90d` 仅是历史兼容输入别名，不能再成为新的正式任务类型。雅仓当前库存动销源文件包含 3/7/15/30/60/90 天累计销量，不提供逐日明细；“逐日销量”“每天销量”“日销量明细”必须明确说明不支持或要求澄清，不能伪造数据。

## 2. 正式链路与职责边界

正式业务入口只允许走下面这条链路：

```text
Desktop 对话框
  → Agent Runtime
  → Skill discovery
  → yacang-export-workflow-map
  → lxeskill yacang export run
  → Intent
  → Planner
  → Executor
  → 平台认证 / 导出 / 下载
  → artifacts[].path 的 XLSX
```

内部 `preview` / `run` CLI 可保留给开发、自动化测试和 Agent 调用，但不能替代正式用户入口。工作台测试卡片不应成为对业务用户暴露的第二条正式入口。

各层只做自己的事：

| 层 | 应承担的职责 | 不应承担的职责 |
| --- | --- | --- |
| Skill | 声明能力、权限类型、输入输出约束 | 直接登录或拼 HTTP 请求 |
| Intent | 识别自然语言、归一化参数、给出澄清或不支持结果 | 提交导出或改变执行顺序 |
| Planner | 生成 canonical 任务与依赖关系 | 接收中文别名或平台原始请求参数 |
| Executor | 复用本轮客户端、执行任务、保留失败隔离 | 重新解释用户自然语言 |
| Client / Auth | 平台登录、验证码、HTTP、状态轮询、下载 | 决定业务类型或绕过生产门禁 |
| Desktop | 安全配置、运行时环境注入、权限快照 | 把明文密码交给前端或 Python 直接读配置文件 |

## 3. Skill、Catalog 与权限接入

1. 每个平台原则上只暴露一个清晰的公开 Skill，避免把同一能力拆成多个可发现入口。
2. 在 Skill frontmatter 中使用公司的正式权限域 `type`，并保持 Catalog、Skill discovery 和权限测试一致。
3. 雅仓当前纳入既有备货权限域：`type: amazon_replenish`。这是复用公司现有授权域的正式决定，不是本地测试绕过。
4. 新平台不要为了跑通测试临时借用不相关的权限类型。先判断它属于已有业务权限域，若没有合适域，再由云端增加正式 grant。
5. `allowed_skill_types` 必须来自公司云端的权限快照。Runtime 根据过滤后的 Skill 列表生成 `LXESKILL_SKILL_SCOPE`；空 scope 必须继续 fail-closed，不能硬编码放行。

关键检查点：

- Skill 是否能被 Catalog 正常加载。
- 设备权限快照是否包含 Skill 的 `type`。
- Agent Runtime 的 scope 是否包含该 Skill。
- 未授权设备是否明确返回 `skill_not_in_scope`，而不是误把业务命令执行到生产。

## 4. 自然语言、仓库与 canonical 参数

自然语言只存在于 Intent 层。执行层只能接收 canonical 参数。

雅仓仓库的唯一来源是 `python/lxeskill_cli/services/yacang/warehouses.py`：

| Canonical code | 展示名 | 可识别示例 |
| --- | --- | --- |
| `MY8801` | 马来西亚仓 | 马来西亚、马来仓、马来、MY |
| `PH8805` | 菲律宾仓 | 菲律宾、菲仓、PH |
| `TH8802` | 泰国仓 | 泰国、泰仓、TH |
| `VN8806` | 越南仓 | 越南、越仓、VN |

规则：

- Intent 支持中文名、简称、标准 code 和混合表达；输出按 `MY8801 → PH8805 → TH8802 → VN8806` 固定顺序去重。
- “四仓”“全部仓库”“所有仓库”解析为四个 canonical code；与具体仓库同时出现时应澄清，不要猜测。
- 中文仓库名不得进入 Planner、Executor、HTTP 参数、`source_fetch_id` 或 canonical result 字段。
- `inbound-listing-time` 永远是 global；即使用户说“马来仓入库时间”，也不得把仓库参数注入执行任务。
- “最近销量”“最近卖得怎么样”等不能确定报表含义的表达应正常追问；明确“销量”“库存动销”“库存和销量”“动销数据”则进入 `inventory-sales`。

实现优先扩展已有 alias、normalization、eval dataset 和参数化测试，不堆叠第二套映射或大量 if/else。

## 5. 数据源、文件与失败隔离

### 5.1 原始文件优先

雅仓 `inventory-sales` 的交付目标是保留平台原始完整工作簿：

- 单仓：直接发布经过验证的原始 source workbook，不用 `openpyxl` 重写，避免破坏格式或内容。
- 多仓：才重建一个合并工作簿；一个 Sheet、一个表头，按固定仓库顺序追加成功仓数据。
- 多仓合并必须完整保留原始 16 列，不改字段名、不裁列、不新增人工业务字段。

当前 16 列为：SKU、商品名、仓库、3天销量、7天销量、15天销量、30天销量、60天销量、90天销量、库存、占用、在途、冻结、可用、缺货数量、创建日期。

分仓 artifact 文件名展示中文仓库名，例如：

```text
雅仓系统-库存动销_泰国仓_2026-09-17.xlsx
```

内部任务、参数、HTTP 和 source fetch 仍只用 `TH8802` 等标准 code。全局入库/上架时间文件不追加仓库名。

### 5.2 执行复用与错误边界

- 每个仓库在一轮 workflow 中只执行一次相应 source fetch，不因最终合并再次提交或下载。
- `execute_export_plan()` 为整轮任务创建并传递一个共享 `YacangClient` 与持久化 `YacangSubmissionStore`；同一轮最多一次逻辑登录，认证 token / session 复用。
- 多仓仍保持每仓一个逻辑任务，不能压成一个不可定位失败的大任务。
- 某仓失败时，其他仓继续；有成功仓则返回成功 artifact，并保留失败仓 diagnostics，状态按现有 `partial_success` 语义返回。
- 最终 artifact 应去重，不能为多个 logical task 重复返回相同 XLSX path。

## 6. 凭据、生产门禁与安全日志

必须复用项目现有 Desktop 配置体系，不建立平台私有 `.env`、JSON、数据库表或第二套 secrets 文件。

雅仓当前规则：

- 手机号保存于 `integrations.yacang.mobile`。
- 密码以 Electron `safeStorage` 加密，字段为 `yacang_password`；前端只看见 `password_configured`，不能回显明文。
- Python 只通过运行时环境变量读取 `LXE_YACANG_MOBILE` 和 `LXE_YACANG_PASSWORD`，不得直接读取 `settings.json` 或 `secrets.bin`。
- `LXE_YACANG_PROD_ENABLED` 是显式运行时生产门禁，不能由 Desktop 默认开启或持久化为普通设置。
- 子进程环境合并顺序为：父进程环境 → 当前 `config.environment()` → 测试 / 运行固定环境；配置环境应覆盖父进程同名变量，但不得写入日志。

真实请求的最低条件是：设备权限已通过、凭据为 SET、且运行环境显式设置 `LXE_YACANG_PROD_ENABLED=true`。任何一项不满足都必须停止，不能由 Agent 自行开启或改用旁路。

敏感信息永远不得进入源码、Git、测试 fixture、普通 UI、错误信息、日志或聊天：账号、密码、Cookie、Token、Authorization、API Key、enrollment 文件内容、一次性密码均是敏感信息。

## 7. 认证、验证码、重试与停止条件

雅仓已有自动验证码登录链路：

```text
GET /sys/customer/verify
  → 自动识别验证码
  → POST /sys/customer/loginV3
```

验证码出现本身不是失败，也不应新增人工验证码旁路。只有以下情况才停止并报告：

- 验证码获取、自动识别或校验失败；
- 平台要求人工验证或出现风控异常；
- 401、403、429；
- `EXPORT_SUBMIT_UNKNOWN` 或 `EXPORT_STATUS_UNKNOWN`；
- 其他未知且不能证明安全重试的错误。

导出提交是副作用操作：未知提交状态绝不能自动重复 submit。普通网络问题是否可重试，必须沿用平台 Client 的既有有限策略；不得在 Agent、Intent 或测试脚本里自行循环重试。

## 8. 开发、测试与 Git 流程

雅仓分支固定关系：

```text
main → feature/new-yacang-module → .worktrees/pool-*
```

非简单变更必须从最新 feature 领取 pool，不能手工创建 worktree：

```powershell
scripts/wt-claim.ps1 <task-slug>
```

流程为：阅读现有职责边界 → 先写失败测试 → 最小实现 → 定向测试 → 只暂存任务文件 → 经确认 commit → 经确认迁回 feature → release pool。不得直接在 main 开发，不得使用 `git add .` 或 `git add -A`，不得自行 push。

建议测试分层：

| 层级 | 重点 |
| --- | --- |
| Intent / eval | alias、歧义、unsupported、canonical 参数 |
| Planner / workflow | 任务数、global 范围、partial success、source 去重 |
| XLSX | 单仓原件、16列、多仓一个 Sheet / 一个表头 / 固定顺序 |
| Executor FakeClient | 一轮一个 client、一次登录、持久化 submission store、停止语义 |
| CLI / Catalog | `--help`、`preview`、Skill discovery、契约兼容 |
| Desktop | IPC validation、安全配置环境注入、权限 scope、友好错误展示 |
| 最小真实探针 | 单仓、单报表、默认日期、一次调用、无并发无批量 |

文档改动也应执行 `git diff --check`；代码改动按受影响模块跑定向测试。合并 main 前再根据 main 实际变化决定是否补跑更广回归，不能把空扫描或被管道吞掉退出码当作通过。

## 9. Desktop Enrollment 与权限验收

本地业务代码通过不等于设备有生产权限。正式联调前必须通过项目正式 Enrollment 和公司云权限快照完成以下验证：

1. 使用 Windows x64 的正式打包 Desktop / 官方安装包导入 `.lxe-enroll`；不要修改 `cloud.managed`、`device_id` 或快照文件伪造纳管。
2. 如需要一次性密码，由操作者在界面中输入；不要复制到聊天、代码或日志。
3. 刷新身份 / 云端连接 / 权限快照，确认 `managed=true`、`device_id` 已存在、permission snapshot 有效。
4. 确认 `permission_v2.grants.skill_types` 与 `allowed_skill_types` 包含雅仓 Skill 的正式类型 `amazon_replenish`。
5. 确认 Runtime 过滤后 scope 非空，`yacang-export-workflow-map` 可被发现。
6. 先执行 preview，确认自然语言 → Intent → Planner 的任务结构正确且没有访问生产。

未纳管或未获 grant 的设备返回 `skill_not_in_scope` 是权限门禁正常工作，不应通过硬编码 scope、伪造快照或放宽 fail-closed 来修复。

## 10. 最小真实联调与交付验收

在负责人明确授权生产探针后，只做一条最小请求，例如单仓、单一 `inventory-sales`、默认日期：

```text
自然语言 → Agent → Skill → Intent → Planner → Executor
→ 自动认证 → 提交导出 → 轮询 → 下载 → XLSX artifact
```

验收记录只保留非敏感事实：权限是否已生效、凭据状态为 SET/MISSING、请求的 canonical 仓库与类型、任务状态、artifact 路径、行数、是否遇到 401/403/429。不得保存凭据或完整请求认证信息。

成功后应确认：

- 用户在 Desktop 对话框看到业务可理解的结果与 XLSX。
- 返回的 `artifacts[].path` 指向实际存在的文件；多文件时遍历全部 artifact。
- 正常业务区域不泄露 CLI、scope、文件系统日志路径、stack trace 或原始凭据。
- 结构化错误与诊断仍保留在受控的开发诊断 / 日志中，并确保默认收起且已脱敏。

## 11. 后续平台复用清单

接入马帮、印尼、菲律宾或其他平台时，逐项确认：

- [ ] 已确认真实报表、字段、日期和仓库语义，不虚构数据。
- [ ] 已确定一个公开 Skill、正式权限 type 和 Catalog 契约。
- [ ] 已把自然语言 alias 限制在 Intent 层，执行层只收 canonical 参数。
- [ ] 已复用公司 Desktop 安全存储和运行时环境注入，不新增明文配置体系。
- [ ] 已实现显式生产门禁，且 Agent 不能自行开启。
- [ ] 已定义登录、验证码、401/403/429、未知提交、未知状态的停止语义。
- [ ] 已明确单仓、多仓、失败隔离、artifact 去重和原始文件保真策略。
- [ ] 已用 FakeClient / fixture 覆盖常规、歧义、权限、失败与安全边界。
- [ ] 已完成正式 Enrollment / 云权限刷新后的 preview 验证。
- [ ] 已在授权下完成一次最小真实端到端导出，并记录非敏感结果。
- [ ] 已精确暂存、经确认提交、合并前检查 main 变化与冲突，且未自行 push。

这份清单的原则是：先保证真实业务语义和安全边界，再追求入口数量、自动化范围或体验优化。
