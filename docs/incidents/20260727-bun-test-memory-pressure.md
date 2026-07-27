# 2026-07-27 Bun 测试内存压力

Status: `Investigating`

## 影响

在 macOS 开发机上执行 Local Agent 全量验证期间，活动监视器显示两个由 Codex 启动的 Bun 进程各占用约 30 GB 内存。机器只有 16 GB 物理内存，随后出现严重内存压力，其他应用被系统暂停，最终需要重启。

重启前没有保留下这两个进程的内存快照，因此本文不把 30 GB 的具体分配来源归因给 Bun、项目测试或某一个测试文件。

## 已确认事实

- 涉及的入口命令是 `bun run verify`，它依次执行 TypeScript 边界检查、workspace typecheck、`bun test` 和 Python Skill 测试。
- 事故时间段的系统日志显示大量 Bun 进程活动和 macOS 内存压力处理；没有发现自动启动 Bun 的常驻服务。
- 重启后单独复跑一轮完整验证成功：Bun 1.3.14 执行 124 个文件中的 671 项测试，全部通过，用时 11.88 秒。
- 复跑期间采样到 `bun test` 的 RSS 约为 750,736 KB（约 733 MiB）；测试结束后 Bun 包装进程降至约 3 MiB，整轮结束后没有残留 Bun 进程。
- 复跑的终端输出约 2,007 行，工具侧估算约 9.5 万 token。这里的 token 是终端文本容量估算，不是模型调用量或内存单位。
- 大量输出主要来自 Runtime 测试：`TypeScriptAgentRuntime` 创建 `RuntimeTurnObserver` 时没有传入测试 logger；未配置 process logging sink 时，默认 logger 会绕过级别过滤，把 Debug、Info、Warn 和 Error JSON 全部写到 stdout。
- Python 测试虽然通过，但退出阶段报告了一个未关闭的 `aiohttp.ClientSession`，并在日志流关闭后触发 `ValueError: I/O operation on closed file`。这是独立的资源清理问题，尚无证据表明它造成了 Bun 的异常内存。

## 尚未确认

- 30 GB 异常是否来自 Bun 1.3.14 测试运行器自身的内存泄漏。
- 项目中的 SQLite、`Bun.serve`、mock 或子进程资源是否在某条失败路径上没有释放。
- 两轮验证是否实际重叠，以及重叠、端口绑定失败或大量日志是否是必要触发条件。
- 单独运行哪一组测试可以稳定复现内存持续增长。

当前只能得出：正常单轮验证不需要 30 GB 内存；事故属于严重但尚未稳定复现的异常路径。

## 临时安全边界

- 同一台开发机上不得并行运行多轮 `bun run verify` 或 `bun test`。
- 启动全量验证前先确认没有遗留 Bun 测试进程；失败后确认完整进程树退出，才能重试。
- 调查复现时必须监控 Bun 进程树的总 RSS。总量达到 6 GiB，或系统内存压力明显恶化时立即终止整组进程。
- 开发阶段优先运行受影响模块的定向测试；只在合并前按仓库规则执行一次全量验证。
- 在根因明确前，不把一次成功复跑视为问题已经解决。

## 后续排查

1. 按测试目录分组运行并记录每组的最大 RSS，找出内存不回落的最小范围。
2. 单独覆盖端口绑定失败、SQLite 错误、Server 启停和子进程清理路径。
3. 为测试环境安装静默或受级别控制的 logger，避免 stdout 噪声干扰资源观测。
4. 修复 Python 测试中未关闭的 `aiohttp.ClientSession`，把无关资源泄漏从调查变量中移除。
5. 捕获可复现进程的采样、Bun 版本对比和最小测试用例；证据指向 Bun 后再提交上游 issue。

## Dashboard 建议边界

本次事故记录不包含 Agent Dashboard 功能修改。关于 Agent/Bot 两表合并、名称展示、时间范围、分页、筛选和下钻的评估属于后续独立任务，避免和运行时事故修复混在同一个变更中。
