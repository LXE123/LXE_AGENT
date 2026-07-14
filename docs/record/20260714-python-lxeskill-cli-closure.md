# LXE Skill CLI Python 闭包（2026-07-14）

Status: `Current`

## 决策

仓库内保留的 Python 运行时统一收拢到 `python/lxeskill_cli/`：

```text
python/
└── lxeskill_cli/
    ├── lxeskill/
    ├── services/
    ├── shared/
    ├── browser_auth_service/
    └── tests/
```

`lxeskill_cli` 只是物理闭包容器，不是 Python package，不创建
`python/lxeskill_cli/__init__.py`。公开 import、`python -m lxeskill`、
`lxeskill` console entrypoint 和 JSONL 协议保持不变。

项目通过 Hatchling 声明四个运行时包。`uv sync` 将当前项目 editable
安装进仓库 `.venv`，因此模块解析不再依赖调用者 cwd，也不需要在 Bun、
launcher、doctor 或子进程之间传递 `PYTHONPATH`。

pytest 的默认发现根收窄到 `python/lxeskill_cli/tests`；仓库 `test:py-tools`
显式追加 `skills`，继续执行技能资产自带的 Python 测试，避免结构迁移降低覆盖率。

## 仓库资产与权限

LXE Skill CLI 是仓库内独立闭包，不是可脱离仓库分发的独立产品。它继续读取
仓库根的 `skills/`、`config/`、`data/`，继续写根 `artifacts/` 与 `var/`。
仓库根由共享定位器根据稳定项目标记向上发现，不再由各模块硬编码
`Path(__file__).parents[N]`。

权限接口保持不变：默认策略仍是根 `config/permission_policy.yaml`，
`LXE_PERMISSION_POLICY_PATH` 覆盖、Gateway Bot/用户准入、
`LXESKILL_SKILL_SCOPE`、catalog `owner_skills`、写保护和 `send_file`
白名单均不改变。

## 状态迁移

browser auth 的 Playwright storage state 属于 LXE Skill CLI 持久状态，默认改为
`var/db/lxeskill/browser_auth_service/mabang_erp/`。TypeScript 版本晋升为 `main` 后，
旧源码目录中的状态已一次性迁入该位置并完成校验；运行时不再读取旧路径。

## 兼容与验证边界

- `scripts.logistics_update_ingest` 移入 `services.agent_cli.amazon_logistic`；
  catalog 对外命令、参数、owner 和协议不变。
- macOS 验证完整 Python/Bun 套件、wheel 内容、任意 cwd CLI 和静态 Windows
  launcher 契约。
- Windows 真机 smoke 负责验证 editable 安装、PowerShell launcher、doctor 与
  Gateway start/stop。
