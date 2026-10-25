# 命令与帮助

lxeskillCLI 按业务用途提供帮助导航：**FBA、备货、运营**。数据采集命令归入其服务的业务，说明中明确马帮、雅仓、上马等来源。公共浏览器能力与共用认证维护另有入口。

这只是帮助导航的分类，现有业务命令名保持不变。例如，发货单下载归入 FBA，但仍执行 `lxeskill mabang delivery export`。

## 查找与使用

```bash
lxeskill --help
lxeskill help fba
lxeskill help replenishment
lxeskill help operations
lxeskill help common

# 按已有命令前缀逐层查询
lxeskill mabang --help
lxeskill mabang delivery --help
lxeskill mabang delivery export --help

# 程序使用的结构化查询
lxeskill list
lxeskill describe mabang delivery export
lxeskill datasets list
```

`help fba` 列出 FBA 业务中的全部命令，包括 `mabang delivery …`；`fba --help` 只列出 `fba` 这个命令前缀的下一层。业务导航和命令路径是两个查询角度，不要把导航分组名再拼到已有命令前面。

具体命令的帮助提供用途、命令行参数、必填项、已声明的默认值、可选值和示例。`replenish template` 的 `action` 是位置参数，例如 `lxeskill replenish template list`；其他参数以各命令帮助为准。

帮助输出可读文本，不执行业务、不联网，不初始化业务目录或日志，不要求配置业务账号。未知帮助目标仍返回结构化错误和非零退出码。`list`、`describe`、`datasets list` 保持原有 JSON 结果契约，也不初始化业务目录或日志。业务执行的 JSON 输出、参数及退出码保持不变。

`internal` 命令不进入默认业务导航或列表；知道完整命令的调用方可以明确查询其帮助。默认隐藏不是执行授权机制。

## 维护方式

命令名称与参数仍以 lxeskillCLI 自己的 [Catalog](../../python/lxeskill_cli/lxeskill/catalog.json) 为准；每条命令的 `help` 保存业务分组、用途、示例与必要说明，参数说明直接取自 `input_schema`。帮助由 [CLI 帮助实现](../../python/lxeskill_cli/lxeskill/help.py)生成，不另外维护一份完整命令清单，也不读取 Skill 文件来拼装帮助。

新增或修改命令时同步维护帮助与示例。Skill 负责任务知识和工作流程，帮助负责命令本身的用法。

## 日志与权限

普通命令的日志文件创建或写入失败时，向 stderr 报告实际文件系统异常并停用失败的文件输出，保留终端诊断，不用日志异常替换业务结果。诊断会脱敏并明确标记截断。日志保留清理失败也不阻断命令。

这不放宽文件写入权限：实际导出文件、保存业务数据或更新认证缓存仍须有对应权限。工作区外的业务目录不会因为日志容错而变得可写。日志布局见 [日志与诊断](../logging.md)。

## 定向验证

从仓库根运行：

```bash
uv run --frozen pytest python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra
bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts
bun test apps/desktop/test/lxeskill-help-sandbox.test.ts
```

最后一项使用真实 CLI 和操作系统权限限制：macOS 使用 Seatbelt；Windows 需先准备 `scripts/prepare-exec-sandbox.ts`，设置 `LXE_EXEC_SANDBOX_NODE`、`LXE_EXEC_SANDBOX_RUNNER` 和 `LXE_EXEC_SANDBOX_NATIVE_TEST=1`。测试包含写入应被拒绝的对照，避免未启用沙箱却误报通过。真实 CLI 集成测试归 Electron，agentcli 的通用测试使用独立 fixture。
