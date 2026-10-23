# 工作区用应用打开

对话顶部和右侧文件树共用分体按钮与本机偏好。应用目录及平台定位规则参考 DeepSeek Harness `639ed01539`，覆盖其 31 个 macOS / Windows 条目，只显示已安装应用。MIT 声明保留在源码和桌面构建中。

首次默认 Finder / 资源管理器。选择菜单项立即打开，成功后才记住；失败保留原选择和实际诊断。主进程负责目录校验、应用检测、图标缓存及参数数组启动，渲染器只能选择内置 ID。左侧列表仍直接打开系统文件管理器，文件关联和内置工具不受目录偏好影响。

## 验证结果

- 最终代码 rebase 到 `6255025b` 后，在 macOS 上运行 `bun run verify:source` 退出码 0：协议、源码边界和类型检查通过；Bun 1962 通过、7 跳过、0 失败；Python 1965 通过、4 跳过。
- 完整验证后只调整了桌面验收脚本的日志输出方式，生产代码没有变化；相关真实 Electron 测试和类型检查再次通过。
- macOS 实际检测到 Finder、VS Code、Terminal，图标读取及中文、空格、特殊字符目录启动通过。
- Windows `PC-20240421FADR` 实际检测到资源管理器、VS Code、Git Bash，三者图标及目录启动通过。
- Windows 最终 `Unpacked` 包构建成功，实际打包程序验收退出码 0（源码 `0edecd35`）：生产 `app://` 页面及 preload、已安装应用检测、三个真实图标和目录启动、目录不存在及未知应用错误均通过。报告位于测试机 `C:\Users\Administrator\AppData\Local\Temp\lxe-packaged-workspace-apps-t0Dt2I\report.json`。
- 两平台 Electron 验证覆盖三处控件共享偏好、失败不改选择、刷新恢复、单应用状态、键盘操作与焦点返回、异步切换目录、明暗主题、窄布局、真实 WebContentsView 遮挡和非可信页面 IPC 拒绝。
- 定向存储及启动测试覆盖目录校验、注册表异常、缓存复用、图标失败、路径参数、环境清理、重复点击及启动器消失后的单次重试。现有侧栏、工作区和文件预览回归通过。

Windows 真实启动验收曾因外部应用继承测试输出句柄而等待管道关闭。验收脚本改用文件输出，按 Electron 自身的退出码结束，不依赖外部应用退出，也不关闭这些应用。

## 复现入口

从仓库根目录运行：

```sh
bun test apps/desktop/test/workspace-applications.test.ts apps/desktop/test/preload-bridge.test.ts apps/dashboard/test/features/sessions/workspace-applications.test.ts
bun test apps/dashboard/test/features/workspace-apps/renderer.test.ts
```

第二条会验证真实 Electron 检测、图标和界面，但默认不启动外部应用。显式设置 `LXE_WORKSPACE_NATIVE_OPEN=1` 后，再运行它可执行本机文件管理器、VS Code 和已安装终端的打开检查。测试使用临时目录，不调用模型。

Windows 打包后可运行 `bun scripts/verify-packaged-workspace-apps.ts dist/desktop-unpacked/win-unpacked`，使用独立应用数据验证实际打包程序的 IPC、应用检测、图标、启动和错误诊断，产出 JSON 报告。

## macOS 图标修正

用户截图暴露了此前图标验收的遗漏：`app.getFileIcon(.app)` 在当前 Mac 上为 Finder、VS Code、Terminal 返回完全相同的通用应用图标。原测试只检查了图片 URL 存在，不能据此认定应用图标正确。

macOS 改用 dsh 的方式，从应用 `Info.plist` 定位 `Resources/*.icns`，用系统 `sips` 转成 128px PNG；没有声明图标时扫描 Resources。转换使用临时目录并在成功、失败后清理，失败仍保留实际诊断和通用图标降级。Windows 继续走现有的原生文件图标接口。

真实 Electron 回归现在会比较这些应用的解码像素，拒绝把同一个占位图当作三个应用图标；同时把真实图片放进菜单，检查加载并截取明暗主题。新增断言在修复前以 `1 !== 3` 失败，修复后通过，已人工检查两种主题下的实际显示。
