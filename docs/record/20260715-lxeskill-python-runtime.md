# LXE Skill CLI Python wheel 运行时（2026-07-15）

Status: `Current`

## 决策

删除 `@lxe/lxeskill-cli` Node/Bun 外壳、PyInstaller spec 和平台 vendor 目录。所有 Runtime
调用统一为隔离的 Python 模块命令：

```text
python -I -m lxeskill <command>
```

源码安装使用项目 `.venv`。Electron 桌面包继续携带 Python `3.12.10`，但不再携带第二份冻结
解释器；Windows 构建器每次从当前 checkout 构建 `lxe_agent` wheel，并把它安装到暂存资源中的
私有 Python。最终用户仍无需安装 Python。

## 构建与缓存边界

基础桌面运行时缓存只保存 Python、锁定的第三方依赖、uv 和 Playwright，不保存 LXE 项目 wheel。
wheel 输出目录每次清空，构建使用持久 `UV_CACHE_DIR`；离线模式通过 uv 的 offline 开关禁止下载，
缺少 Hatchling 构建缓存时立即失败。资源装配器只接受内部输入 `LXE_DESKTOP_PROJECT_WHEEL`，并用
构建输入中的 uv 执行：

```text
uv pip install --python <private-python> --break-system-packages \
  --offline --no-deps --reinstall <current-wheel>
```

wheel 不复制进最终资源。构造式资源白名单只复制私有 Python 中已安装的模块，且不创建旧
`runtime/lxeskill` 目录。uv 只属于构建和离线缓存边界，不复制到最终 `runtime/uv`；Skills
中的 `uv run --frozen python ...` 由 ExecShellAdapter 直接改写为受管 Python。

## 运行和健康边界

桌面 Main 只向 agent-cli 提供 `LXE_MANAGED_PYTHON` 和私有工具 PATH；Runtime 优先使用该解释器，
源码模式使用项目 `.venv`。两种模式都启用 `-I` 和 `PYTHONNOUSERSITE=1`，不读取用户 site-packages。
旧 `LXESKILL_BINARY_PATH` 与 `LXESKILL_REQUIRE_BUNDLE` 不再受支持。

> 2026-07-16：固定 28 命令门禁已由
> [物流服务退役记录](20260716-retire-logistics-service.md) 取代；打包现在比较源码与 wheel 的完整命令集合。

桌面 IPC 与界面的 `lxeskill` 健康字段保持不变。打包阶段比较源码 catalog 与 wheel 中
`lxeskill list` 返回的完整命令集合，不冻结命令数量；随后写入最小 readiness
marker。运行时启动还会真实执行一次 `lxeskill list`：成功后才启动依赖它的维护任务；失败时只把
`lxeskill` 标记为异常，普通 Agent 能力继续运行，业务命令在创建子进程前返回不可重试的环境错误。

源码模式不会自动修改开发环境。若 `.venv` 的 editable 安装损坏，状态信息会提示操作者在资源仓库
执行 `uv sync --frozen --all-groups --python 3.12.10`；打包模式则提示重新安装或重建应用。私有
Python、模块文件和 readiness marker 仍是打包运行时的静态健康前提。
