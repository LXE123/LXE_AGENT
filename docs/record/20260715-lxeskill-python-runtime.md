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

wheel 不复制进最终资源。manifest 应包含私有 Python `site-packages/lxeskill` 下的模块文件，且禁止
出现旧 `runtime/lxeskill` 目录。uv 只属于构建和离线缓存边界，不复制到最终 `runtime/uv`；Skills
中的 `uv run --frozen python ...` 由 ExecShellAdapter 直接改写为受管 Python。

## 运行和健康边界

桌面 Main 只向 agent-cli 提供 `LXE_MANAGED_PYTHON` 和私有工具 PATH；Runtime 优先使用该解释器，
源码模式使用项目 `.venv`。两种模式都启用 `-I` 和 `PYTHONNOUSERSITE=1`，不读取用户 site-packages。
旧 `LXESKILL_BINARY_PATH` 与 `LXESKILL_REQUIRE_BUNDLE` 不再受支持。

桌面 IPC 与界面的 `lxeskill` 健康字段保持不变。打包阶段以 `lxeskill list` 返回 28 个命令作为
行为冒烟，并写入包含 wheel 哈希的 readiness marker；健康检查要求私有 Python、模块文件和该
marker 同时存在才判定 ready。
