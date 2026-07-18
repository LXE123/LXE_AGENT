# 本地状态与数据库

状态：Current

## 先说结论

Desktop 不再把所有状态塞进一个 `local_agent.sqlite3`。Electron Main、私有 `agent-cli` 和 Python 业务命令各自拥有自己的数据库，避免两个进程同时写同一个 SQLite 文件。

会话正文也不放在 SQLite 里，而是写入 append-only 的 Transcript v2 JSONL。SQLite 保存适合查询和更新的状态，JSONL 保存按时间追加的会话事件。

## 当前存储分工

| 文件 | 谁写入 | 保存什么 |
| --- | --- | --- |
| `db/gateway.sqlite3` | Electron Main / Gateway | Gateway session、平台来源和 response route |
| `db/agent.sqlite3` | 私有 `agent-cli` / Runtime | Agent session、pending event、usage、模型信息和 transcript 索引 |
| `db/lxeskill.sqlite3` | 一次性 Python `lxeskill` 命令 | Python 业务侧状态，目前主要是紫鸟浏览器会话 |
| `db/sessions.json` | Gateway | 平台 source 到 session id 的稳定绑定 |
| `db/session_transcripts/<session>.jsonl` | Runtime | 原始消息、turn metadata 和 `context_patch` |
| `db/machine_identity.json` | Runtime 维护任务 | 可选 Data Server 使用的本机身份 |

这些路径都位于 Desktop 的应用数据目录。源码开发没有显式设置 `LXE_DATA_ROOT` 时，逻辑 data root 默认落在仓库的 `var/` 下。

测试 fixture 或旧源码环境里仍可能出现 `local_agent.sqlite3` 这个文件名；它不是 Desktop 当前默认的单库布局。

## 为什么要拆开

- Gateway 必须在 Runtime 重启时继续知道消息来自哪里、结果应该发到哪里。
- Runtime 需要独立维护模型上下文、pending event 和 usage。
- Python 命令是按需启动的短进程，只写自己负责的业务状态。
- 每个数据库只有一个明确的写入方，减少锁冲突和跨进程耦合。

Gateway 创建 session 时，会同时让 Gateway store 和 Agent store 建立对应记录；response route 留在 Gateway，pending event 留在 Agent。两边通过稳定的 session id 关联，不通过共享 SQLite 表通信。

## Transcript v2

普通 user、assistant 和 tool 消息按顺序追加到 JSONL。压缩、修复或重置上下文时，Runtime 追加一个最小 `context_patch`，只说明当前模型视图中哪一段要删除、插入什么内容。

旧行不会被回写，因此 Dashboard 可以保留完整审计展示；模型 replay 则按顺序应用 `context_patch`，得到下一次请求真正使用的短历史。两种视图都来自同一个 transcript，但用途不同。

详细事件格式和兼容规则见 [Context Persistence](../harness/runtime/context/context_persistence.md)。

## 一致性与安全

- session、route、pending event 和 usage 更新使用各自数据库事务。
- tool call 与 tool result 必须在 transcript 中保持闭合。
- 轻量查询只读 SQLite metadata；需要模型历史时才 replay transcript。
- 程序管理的数据库、日志和本地配置不能由模型文件工具修改。
- 凭证由桌面安全配置保存，不因为 SQLite 被 Git 忽略就写进数据库。
- Workspace Skill、AGENTS Instructions 和搜索服务只做进程内缓存，不新增数据库表或磁盘解析缓存。

## 备份与恢复

手工迁移或修复前，先完全退出 Desktop，再一起备份整个 `db/` 目录。只复制某一个 SQLite 或只复制 transcript，可能让 session、route 和历史互相对不上。

恢复后至少检查：

1. Gateway 能找到原 session 和 response route。
2. Agent 能 replay transcript，且最近消息与 Dashboard 一致。
3. pending event、usage 和 transcript 索引可以正常读取。
4. 三个 SQLite 都没有 integrity 或 lock 错误。

优先使用带备份和完整性检查的迁移脚本，不直接手改数据库行或 JSONL。

## 排障顺序

消息路由错误先看 `gateway.sqlite3` 和 `sessions.json`；模型历史错误看 transcript 与 `context_patch`；后台任务或 usage 错误看 `agent.sqlite3`；紫鸟会话状态错误再看 `lxeskill.sqlite3`。

当前路径装配见 [Desktop Gateway](/apps/desktop/src/main/desktop-gateway.ts)，Transcript 实现见 [Runtime storage](/packages/agent/runtime/src/state/storage.ts)。
