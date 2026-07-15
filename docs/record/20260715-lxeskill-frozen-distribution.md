# LXE Skill CLI 冻结分发（2026-07-15）

Status: `Archive`

> 本决策已由 [LXE Skill CLI Python wheel 运行时](./20260715-lxeskill-python-runtime.md)取代。
> 以下内容仅保留为历史记录，不代表当前实现。

## 决策

`lxeskill` 增加与 DWS/Lark CLI 同类的“脚本外壳 + 预编译核心”分发层，但核心技术随
源码语言调整为 PyInstaller，而不是 Go：

```text
@lxe/lxeskill-cli
├── bin/lxeskill.js                       Node/Bun 参数与 stdio 转发
└── vendor/<platform>-<arch>/lxeskill/   PyInstaller onedir 运行时
    ├── lxeskill[.exe]
    └── _internal/
```

选择 `onedir`，不选择 `onefile`。`lxeskill` 是频繁启动的一次性命令，`onefile` 每次都要先把
Python 解释器、扩展模块和 Playwright driver 解压到临时目录，会把分发便利转化成每次调用的
启动成本；`onedir` 只在安装时解包一次。

冻结运行时仍然是仓库内产品，不改变 LXE Skill CLI 的资产边界。Node/Bun 外壳将仓库根写入
`LXE_ROOT`，冻结程序从该根读取 `skills/`、`config/`、`data/`，并继续写入 `artifacts/`、`var/`。
无效的显式 `LXE_ROOT` 必须失败，不允许静默落到另一个 checkout。

## 执行优先级

以下所有生产入口统一遵守同一顺序：

1. `LXESKILL_BINARY_PATH` 指定的测试或运维覆盖；
2. 当前平台的 `vendor/<platform>-<arch>/lxeskill/lxeskill[.exe]`；
3. 源码开发环境的 `.venv/python -m lxeskill` 回退。

覆盖范围包括独立 `lxeskill` launcher、模型 `exec` 中的受管命令重写，以及 Gateway 后台认证
维护任务，避免只包装终端命令、内部路径仍绕回 Python 的双轨行为。设置
`LXESKILL_REQUIRE_BUNDLE=1` 可禁止开发回退，用于发布物验收。

## 构建与发布边界

PyInstaller 不是交叉编译器。每个目标必须在相同 OS/CPU 的构建机上执行：

```bash
bun run lxeskill:bundle
bun run lxeskill:pack
```

构建固定使用 Python `3.12.10`、锁文件中的依赖和 PyInstaller `6.21.0`。spec 显式收集 catalog
动态模块、四个 LXE Python package 的数据文件，以及 Playwright 自带的匹配 Node driver。
smoke 必须验证 `help`、`list`、`doctor`、全部 catalog 动态 import 和 Playwright driver。

生成的 `vendor/*` 与 `dist/` 不提交 Git。发布流水线负责分别生成 Windows/macOS/Linux 的
artifact；一个只含单平台 vendor 的 tarball 不能冒充通用 npm 包。若以后发布到 npm registry，
应拆成公共 launcher 包和带 `os`/`cpu` 限制的可选平台包；当前内部安装物可以直接携带其目标
平台目录。

## 体积与 Python 边界

这不是 Go 级别的 20 MB 二进制。Playwright Python wheel 自带的 Node driver 单独约 141 MB，
再加 pandas、NumPy、Pillow、openpyxl、Selenium 和 CPython，当前 macOS arm64 onedir 约
251 MiB，npm gzip tarball 约 94 MB（约 89 MiB）。

冻结 `lxeskill` 只消除这条核心命令的运行时 Python 依赖。仓库中可由模型直接调用的其他 Python
skill 脚本仍需要项目 `.venv`；在这些脚本迁移或独立打包前，安装器不能删除 uv/Python。
