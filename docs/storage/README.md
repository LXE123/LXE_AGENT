# 本地数据与存储

本文说明项目运行所需和运行过程中产生的数据，由谁管理、怎样保存，以及如何备份与恢复。下文按管理方式区分数据库存储和文件存储；数据库本身也以文件形式落盘。

## 数据归属与目录

Electron / Gateway、agentcli 和 lxeskillCLI 分别管理自己的数据，通过约定接口协作，不把其他模块的内部存储当作集成接口。

- **Electron / Gateway**：管理桌面配置、凭据、预览缓存，以及接入侧的会话绑定和响应路由。Runtime 重启时，Gateway 仍能确定消息来源和结果交付位置。
- **agentcli**：管理 Agent 会话、执行状态、消息与工具记录、索引和统计。
- **lxeskillCLI**：管理业务数据、配置、输入资料和文件产出；紫鸟浏览器真实状态以外部客户端实时接口为准，本地只保留可丢弃的缓存。

详细职责见 [架构简介](../architecture/README.md#3-数据归属)。存储格式不改变数据归属；各模块内部的并发访问由其存储实现管理，不代表每个数据库或文件只能由一个操作系统进程写入。

下表中的 `db/` 等相对路径均以宿主实际使用的数据目录为根。Desktop 的默认位置、`LXE_DATA_ROOT` 和升级迁移统一见 [程序与用户数据](../desktop/data-location.md)；独立 CLI 的目录选择见 [Agent CLI exec](../harness/runtime/agent_cli_exec.md#会话与存储)。工作区文件可以位于应用数据目录之外，不能按程序安装目录推导存储位置。

## 数据库存储

SQLite 保存适合查询和更新的状态、索引及统计，消息和工具记录正文保存在后文的 JSONL 文件中。

| 文件 | 所属模块／维护方 | 保存什么 |
| --- | --- | --- |
| `db/gateway.sqlite3` | Electron Main / Gateway | Gateway session、平台来源和 response route |
| `db/agent.sqlite3` | 私有 `agent-cli` / Runtime | Agent session（含独立的 `permission_mode`）、pending event、usage、模型信息和 transcript 索引 |
| `db/exec-sessions/<thread-id>/agent.sqlite3` | 一次性 `agent-cli exec` / Runtime | 单个 CLI thread 的 session、usage、模型信息和 transcript 索引 |
| `db/lxeskill.sqlite3` | lxeskillCLI | 业务状态与可丢弃的紫鸟会话缓存；浏览器真实状态以紫鸟客户端实时接口为准 |

session、route、pending event 和 usage 更新使用各自数据库事务。Gateway 创建 session 时，会同时让 Gateway store 和 Agent store 建立对应记录；response route 留在 Gateway，pending event 留在 Agent。两边通过稳定的 session id 关联，不通过共享 SQLite 表通信。

独立 CLI 为每个持久化 thread 使用单独的数据库，并用独占锁保证同一时刻只有一个 `exec resume` 写入。`--ephemeral` 改用临时存储并在结束时删除，具体规则见 [Agent CLI exec](../harness/runtime/agent_cli_exec.md#会话与存储)。

测试 fixture 或旧源码环境里仍可能出现 `local_agent.sqlite3` 这个文件名；它不是 Desktop 当前默认的单库布局。

## 文件存储

JSON、JSONL 和业务文件按各自格式及目录规则管理。文件放在 `db/` 下不代表它就是 SQLite 数据库。

| 文件 | 所属模块／维护方 | 保存什么 |
| --- | --- | --- |
| `db/sessions.json` | Gateway | 平台 source 到 session id 的稳定绑定 |
| `db/session_transcripts/<session>.jsonl` | agentcli / Runtime | 原始消息、工具记录、turn metadata 和 `context_patch` |
| `db/exec-sessions/<thread-id>/session_transcripts/<thread-id>.jsonl` | 一次性 `agent-cli exec` / Runtime | 独立 CLI thread 的会话记录 |
| `db/machine_identity.json` | Desktop 与 agentcli 用量同步服务（共用 Core 实现） | Cloud、WireGuard 和可选 Data Server 共用的本机身份 |

普通 user、assistant 和 tool 消息按顺序追加到 JSONL。压缩、修复或重置上下文时，Runtime 追加一个最小 `context_patch`，只说明当前模型视图中哪一段要删除、插入什么内容。

旧行不会被回写，因此 Dashboard 可以保留完整审计展示；模型 replay 则按顺序应用 `context_patch`，得到下一次请求真正使用的短历史。两种视图都来自同一个 transcript，但用途不同。

详细事件格式和兼容规则见 [Context Persistence](../harness/runtime/context/context_persistence.md)。

其他文件按用途查阅对应专题，本篇不重复各自的格式和清理规则：

| 类型 | 管理方式与阅读入口 |
| --- | --- |
| 配置与凭据 | Electron 管理 `config/` 下的设置、本地模型 Key 和加密凭据，见 [桌面配置](../desktop/README.md#桌面配置与安全)；lxeskillCLI 自行管理业务配置，例如 [越南备货参数](../lxeskill-cli/vietnam-replenishment.md#设置与本轮快照)。 |
| 日志 | 各模块输出诊断记录，托管日志位于数据目录的 `logs/` 下；级别、脱敏和保留规则见 [日志与诊断](../logging.md)。 |
| 缓存与临时文件 | 例如 Electron 的 `cache/file-previews/`，以及命令执行的输出和临时目录；分别见 [文件预览](../desktop/file-preview.md)和 [执行路径与权限](../harness/runtime/permission-policy.md)。 |
| 输入资料 | 业务模板、报表及本轮快照由 lxeskillCLI 的业务实现管理，例如 [越南备货](../lxeskill-cli/vietnam-replenishment.md)会为本轮计算复制输入快照，保留原文件。 |
| 产出文件 | 当前工作区的 `.lxeagent/artifacts/` 用于项目约定的产物；模型也可按任务在工作区中创建普通文件。路径与写入范围见 [权限专题](../harness/runtime/permission-policy.md#轻策略与路径属主)。 |

## 一致性与安全

- tool call 与 tool result 必须在 transcript 中保持闭合。
- 轻量查询只读 SQLite metadata；需要模型历史时才 replay transcript。
- 工具的文件写入范围由 [权限策略](../harness/runtime/permission-policy.md)控制；数据目录不另设统一写保护，位于所选工作区内的应用数据也进入工作区写入范围。
- 公司身份和集成凭证由桌面安全存储保存；用户本地模型 Key 明文写入 `config/auth.json`，具体保护与访问规则以桌面配置手册为准。
- Workspace Skill、AGENTS Instructions 和搜索服务只做进程内缓存，不新增数据库表或磁盘解析缓存。

待回答问题及其唤醒回调只存在 Bun Runtime 内存中，问题和最终工具结果进入会话历史。界面刷新重新查询当前问题；Agent 重启不会恢复旧等待，未闭合调用沿用历史修复机制处理。详见 [结构化提问](../harness/runtime/tools/ask-user-question.md)。

## 备份与恢复

手工迁移或修复前，先停止写入这份数据的 Desktop 和独立 CLI。会话数据应一起备份整个 `db/` 目录；只复制某一个 SQLite 或只复制 transcript，可能让 session、route 和历史互相对不上。独立 CLI 的 thread 数据库和对应 `session_transcripts/` 也要一起保留。

`db/` 副本不包含全部应用数据。完整迁移还需保留相应配置、业务输入资料和工作区文件；外部工作区不一定在应用数据目录中。目录迁移及加密凭据处理见 [程序与用户数据](../desktop/data-location.md)，缓存与临时文件的恢复按各专题规则处理。

恢复后至少检查：

1. Gateway 能找到原 session 和 response route。
2. Agent 能 replay transcript，且最近消息与 Dashboard 一致。
3. pending event、usage 和 transcript 索引可以正常读取。
4. 相关 SQLite 都没有 integrity 或 lock 错误。

优先使用带备份和完整性检查的迁移脚本，不直接手改数据库行或 JSONL。

## 排障顺序

消息路由错误先看 `gateway.sqlite3` 和 `sessions.json`；模型历史错误看 transcript 与 `context_patch`；后台任务或 usage 错误看 `agent.sqlite3`；紫鸟会话状态错误再看 `lxeskill.sqlite3`。

当前路径装配见 [Desktop Gateway](../../apps/desktop/src/main/desktop-gateway.ts)，Transcript 实现见 [Runtime storage](../../packages/agent/runtime/src/state/storage.ts)。
Machine identity 的唯一实现见 [Core machine identity](../../packages/foundation/core/src/machine-identity.ts)；移动代码不会迁移或重写现有 JSON 文件。
