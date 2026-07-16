# TypeScript Workspace 大域/小域布局（2026-07-14）

Status: `Archive (Superseded)`

> 本文保留 2026-07-14 的五 workspace 和 HTTP Dashboard 历史决策。当前 Desktop 已增加 Electron、私有 Agent CLI 和 Desktop Protocol，进程与目录事实见 [Desktop 技术手册](../desktop/README.md)。

本记录部分取代《仓库结构契约》中“不动 TS workspace 布局”的旧结论。五个 workspace package 保持独立，公开 package 名与依赖方向不变，只重组物理目录与源码领域。

## 决策

```text
apps/
├── gateway/
└── dashboard/

packages/
├── foundation/
│   ├── core/
│   └── protocol/
└── agent/
    └── runtime/
```

- `apps/` 只放可独立运行或构建的应用；Gateway 与 Dashboard 同属这一层。
- `packages/` 先按大域分组，再保留 `core`、`protocol`、`runtime` 三个独立 workspace package。
- package 名继续使用 `@lxe/gateway`、`agent-dashboard`、`@lxe/core`、`@lxe/protocol`、`@lxe/runtime`。
- Gateway、Runtime 与 Dashboard 的生产源码按领域进入二级目录；五个 workspace 的测试统一进入镜像 `test/`。
- Core 与 Protocol 规模较小，源码保持扁平。
- Runtime 的模型描述配置属于仓库装配配置，移入根 `config/llm/`，不再由 Dashboard 硬编码 Runtime package 的物理位置。

## 兼容边界

- 根命令、CLI、权限策略、数据库、日志、LXE Skill CLI 和 JSONL 协议不变。
- 依赖方向保持 `gateway -> runtime -> core/protocol`；Dashboard 只通过 Gateway HTTP API 交互。
- 本批不拆分大文件，不改变业务行为。

## 校验

`python/lxeskill_cli/tests/infra/test_repo_structure.py` 冻结 workspace 大域和源码一级领域。TypeScript production boundary、workspace typecheck、Bun/Python 测试与两端构建负责验证路径迁移没有改变运行时契约。
