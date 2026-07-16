# LXE Skill CLI Python 直连运行时（2026-07-15）

Status: `Current`

## 决策

LXE Agent 不再维护 `lxeskill` 的 Node/Bun 启动壳和 PyInstaller 冻结运行时。Runtime、Gateway
后台任务以及 Windows、macOS/Linux 启动器统一启动项目 `.venv` 中的一次性 Python 子进程：

```text
Runtime / Gateway / launcher
└── .venv Python -m lxeskill <arguments>
    └── python/lxeskill_cli/lxeskill
```

用户接口仍为 `lxeskill ...` 和 `LXE skill ...`。这只是移除中间分发层，不改变 CLI 命令、stdio、
退出码、catalog 或业务模块边界。

## 运行边界

- Python 固定为 `3.12.10`，由 `uv sync --frozen --all-groups` 创建和校验项目 `.venv`。
- `lxeskill` 按命令启动并在完成后退出，不引入常驻 Python 服务。
- Runtime 只接受项目 `.venv`，不搜索系统 Python、PATH 中的 `lxeskill` 或平台 vendor 目录。
- 缺少项目 Python 时立即报告明确路径，不回退到其他解释器。
- `LXESKILL_BINARY_PATH` 和 `LXESKILL_REQUIRE_BUNDLE` 不再是受支持的运行时接口。

## 删除的分发层

删除 `packages/agent/lxeskill-cli` workspace、PyInstaller build/spec、vendor 约定和对应构建命令。
PyInstaller 同时从 Python 开发依赖与锁文件移除。历史冻结方案保留在
[LXE Skill CLI 冻结分发](./20260715-lxeskill-frozen-distribution.md)，状态改为 `Archive`。

> 2026-07-16：本文所述命令边界后来由
> [物流服务退役记录](20260716-retire-logistics-service.md) 更新；物流报价和费率导入已下线，
> 当前 catalog 为 26 个命令。
