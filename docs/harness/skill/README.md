# Skill 手册

Skill 为模型提供任务知识与工作上下文。任务指引保存在各自的 `SKILL.md` 及附属文件中；本篇维护发现、加载、管理和统计机制。Skill 与程序模块依赖的区别见 [PR 审查规范](../../pr-review.md)。

## 来源与发现

| 来源 | 位置 | 同名优先级 |
| --- | --- | --- |
| 项目预置 | 仓库 [`skills/`](../../../skills)；安装版对应随包资源 | 最高 |
| 用户管理 | `<dataRoot>/skills`，可由 `LXE_USER_SKILLS_ROOT` 覆盖 | 其次 |
| 共享 Skill | `~/.agents/skills` | 最后 |

实际数据目录见 [数据位置](../../desktop/data-location.md)。模型可从 `environment_context.user_skills_root` 获取用户目录；写在其他目录的文件不会因此被自动发现。安装版的随包资源与用户工作区分开，模型读取的 manifest 路径可以是绝对路径。

[`SkillCatalog`](../../../packages/agent/runtime/src/tooling/skills.ts) 递归查找 `SKILL.md`，按实际路径去重、解析元数据，再处理同名冲突、禁用状态与允许的类型。同名胜出项先确定，禁用或过滤它不会暴露低优先级的同名项。外部文件无效或冲突时保留逐项诊断；项目预置资源的错误严格报出。

`references` 元数据声明的文件须为相对路径，存在于 Skill 根目录中，解析软链接后也不能越界。这个校验只约束声明的资源；模型调用文件工具和命令时，仍遵循 [执行权限与沙箱](../runtime/permission-policy.md)。

禁用状态单独保存在 `<dataRoot>/config/skill-states.local.json`，正文以 Markdown 文件为准。Skill 在使用边界重新扫描：包括取得 turn 的 Workspace Lease、显式刷新及加载用户指定的 Skill；不是依赖文件监听后台不断扫描。变更会使后续快照和界面查询失效重载，工作区缓存见 [Workspace Instance](../runtime/workspace_instances.md)。

## 目录、加载与激活

这里的 **Agent SkillCatalog** 是从 Skill 文件生成的目录；**lxeskillCLI 的 `catalog.json`** 是业务 CLI 内部维护的命令契约，两者不是同一个 Catalog。

通常先把可用 Skill 的名称、类型、简介、指引路径等简要信息加入提示词，模型按任务需要用 `read` 读取正文。读取当前允许的 manifest 路径可以激活该 Skill 的 owner tools；新增工具从下一 step 开始可见。

用户在输入中明确指定 `/skill-name` 时，Runtime 也可加载对应正文，作为 `<skill_content>` 工作上下文追加，并激活该 Skill。显式选择、读取文件和执行业务命令是不同动作，不能把它们都算作一次业务执行。

Skill 中的资源路径以该 Skill 所在目录为基准。普通工具的相对文件路径仍以会话工作区为基准；读取随包 Skill 时应使用目录给出的实际路径。

## 用户 Skill 管理

通过对话要求创建、修改或整理 Skill，由预置 [skill-creator](../../../skills/skill-creator/SKILL.md) 指导模型使用现有文件和命令工具。命名、文件组织和静态校验方法以该 Skill 为准；附属脚本的行为需要按任务另行验证。

桌面 Skills 页面提供列表、正文与附属文件预览、来源和状态。用户管理的条目归入 Default 展示组，也会显示无效或被遮蔽的条目；展示分组不修改 manifest 类型或授权。新增和“用于对话”只填写新对话草稿，不自动发送。界面当前没有启停开关，但仍读取既有禁用状态。

用户 Skill 的管理通过 Dashboard RPC 完成，不是新增的模型 Tool。这些管理接口使用服务端提供的路径标识和版本，过时请求会失败；删除将整个目录移入 `<dataRoot>/trash/skills`，该目录不参与发现。跨卷时先复制并复核版本再删除源目录；删除失败保留恢复副本并报告位置。恢复可通过对话要求模型移回目录。共享原文件不自动迁移或重写。

实现入口：[发现与校验](../../../packages/agent/runtime/src/tooling/skills.ts)、[用户文件管理](../../../packages/agent/runtime/src/tooling/user-skill-files.ts)。

## 业务指引与 CLI

业务 Skill 说明工作步骤、输入、依赖及命令用法，必要时也可以介绍模块内部结构作为工作上下文。lxeskillCLI 的命令契约由其自身维护；调用方通过 `lxeskill list`、`lxeskill describe ...`、`lxeskill datasets list` 按需查询。Agent 工具使用通用执行权限和进程规则，不直接加载 `catalog.json`。

完整业务说明只维护在 [`skills/`](../../../skills) 中，可从 [FBA 工作流](../../../skills/fba-workflow-map/SKILL.md)、[Amazon 补货工作流](../../../skills/replenishment-workflow-map/SKILL.md)、[东南亚备货工作流](../../../skills/southeast-asia-replenishment-workflow-map/SKILL.md)等入口查找，或使用桌面 Skill 列表查看当前可用项。项目不内置的外部 CLI 可从自身文档查询用法。外部平台原始资料保留在 [reference/](reference/README.md)，不代替当前运行指引。

## 读取调用与命令统计

统计组件观察工具调用请求：

- 每次原生 `read` 的目标匹配本轮发现的 Skill 文件，就计一次 **Skill 读取调用**，重复读取重复计数。
- 对直接以 `lxeskill` 或 `lxeskill.cmd` 开头的 `exec` 请求做简单识别；回合结束时通过公开 `lxeskill list` 查询命令归属，计入相应 Skill 的 **命令调用次数**。不解析所有 shell 包装形式，也不把任意命令猜成 Skill 调用。

两者都是调用次数，不代表读取成功或业务成功。`/skill-name` 的直接注入不是一次原生 `read`；工具激活也不是独立的统计计数。归属查询失败保留诊断，不拦截工具执行。

Skill 统计不上传 errors 和 duration_ms；通用工具仍保留自己的错误与耗时指标。实现见 [TurnStatistics](../../../packages/agent/runtime/src/statistics/turn-statistics.ts)，上传与恢复见 [统计上传](../runtime/native-statistics-upload.md)。

## UI 中文名称

[`config/skill-labels.json`](../../../config/skill-labels.json) 维护官方中文展示名；它不参与模型提示词、命令或权限判断。中文界面按 Skill `name` 查找，英文界面和未知标识保留原名。

同一 `name` 保持同一业务含义；删除 Skill 后保留名称映射，让历史统计可读。修改中文名会统一影响新旧展示，不修改历史记录或统计分组。

遥测服务器仓库用 `uv run --frozen python scripts/import-skill-labels --agent-root <本仓库路径>` 生成发布快照，再加 `--check` 检查。快照不手工编辑；检查会阻止缺少历史键的旧 checkout 覆盖已有映射。两端分别发布，服务器尚未同步的新标识暂时显示原名。

修改发现、冲突或用户文件管理时，可从 [Skill 测试](../../../packages/agent/runtime/test/tooling/skills.test.ts)、[用户 Skill 测试](../../../packages/agent/runtime/test/tooling/user-skills.test.ts)选择定向验证；只修改业务指引时，核对对应 Skill 与实际接口即可。
