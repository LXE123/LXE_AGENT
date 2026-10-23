# 文件预览验收记录

## 本地 HTML 预览（2026-10-02）

支持 `.html` / `.htm` 的网页与源码模式。内嵌脚本和样式、直接相对 CSS／普通 JS、data 图片及网络资源已验证；不打包本地图片、模块和 CSS 间接依赖。主界面脚本 CSP 保持不变，独立 `lxe-preview:` 文档使用不含同源权限的脚本沙箱。没有数据库迁移或 Agent 工具变更。

- macOS ARM64 与 Windows x64 的真实 Electron 均通过 12 组 HTML 场景：中文／空格路径、交互、网络资源与 CORS、父页面／IPC／Node 隔离、禁止弹窗／表单／下载／顶层导航、源码切换、根文件与 CSS／JS 更新、真实错误与重试、快速切换会话、关闭及整页刷新清理、侧栏容器调宽，以及开发 HTTP 与生产 `app://` 来源。测试在本机 HTTP 夹具上验证网络行为，不依赖公网。
- 文件服务测试覆盖工作区边界、外部产物目录范围、符号链接、会话授权失效、UTF-8 解码失败、4 MiB／64 资源／32 MiB 上限、取消及令牌释放。依赖缺失保留真实 `ENOENT`，不会把存在的 HTML 根文件标成已删除。
- 两平台现有文件查看器的 18 组 Electron 回归通过，覆盖 Markdown、图片、PDF、Excel、目录树和标签状态。macOS 手动终端／浏览器的 17 组回归通过；使用独立空缓存重新转换四种 Word/PPT 格式，源文件哈希不变，损坏文档保留原引擎诊断。
- 最终 rebase 后的 `bun run verify:source` 退出码为 0：协议与生产边界检查、全工作区类型检查通过；JavaScript **1,919 通过 / 7 跳过 / 0 失败**，Python **1,965 通过 / 4 跳过**。首轮发现的入口文件行数超限已通过提取原有布局组件修复；尺寸测试按真实侧栏容器变化检查，并等待新 iframe，避免桌面窗口管理器和旧页面影响断言。

Windows 实际打包程序另由 `scripts/verify-packaged-html.ts` 验证。脚本使用原包的可执行文件及资源，以独立 `var` 启动，调用生产 Runtime 创建空会话，经生产 preload／IPC 准备中文路径的 HTML 与相对 CSS／JS，再在受生产 CSP 约束的 iframe 中确认交互和隔离，最后释放句柄、删除测试会话并退出。此截图是实际打包程序中的验收 iframe；查看器工具栏与模式切换由上述组件夹具另行验证。

最终 Windows `Unpacked -Offline` 构建及实际打包程序验收均退出码 0。报告保存在验收机 `C:\Users\Administrator\AppData\Local\Temp\lxe-packaged-html-PWHpvn\report.json`，包位于 `D:\projects\LXE_AGENT\.worktrees\pool-1\dist\desktop-unpacked\win-unpacked`。全量验证后 `main` 另合入了独立的资源体积统计调整；再次 rebase 后，相关资源统计及 Windows 打包路线的 12 项定向测试通过，HTML 代码没有再改动。

日期：2026-10-01。Kit 固定 0.1.3；React 保持 LXE 原有的 19，未引入第二份 React。

## macOS ARM64

已取得真实结果：

- 文件引用、跨会话产物、目录分页、中文/空格路径、越界符号链接、历史图片、文件修改及删除、文件大小限制。
- Electron 43 / Chromium 实测八组交互：Markdown 本地图片、多标签去重，FortuneSheet 挂载/选择/复制/缩放尺寸，PDF Worker/文字层/实际像素，图片和 HTML 边界，应用菜单，隐藏文件和会话隔离，版本刷新释放，窄窗口和重启恢复。界面截图确认保存缓存值 10、字符串 001 和中文 Word 画面可见。
- XLSX 保存的公式与缓存、多工作表、合并单元格、冻结列；CSV 前导零、公式样字符串及异常输入。
- 真实 DOCX、PPTX、DOC、PPT 转为 PDF，缓存复用；四个源文件哈希保持不变。损坏文件保留 Kit 的 `invalid-document` 诊断。测试文件使用本地生成的中文文档与 DeepSeek Harness 的旧版样本。
- 真实子进程取消、超时、缺失可执行文件；转换串行、共享消费者释放。
- AppKit 返回真实默认应用 TextEdit、15 个关联应用及图标；指定 TextEdit、Electron shell 默认打开及文件定位成功，未知扩展名返回零个关联应用，伪造的失效应用被拒绝。
- 生产 Dashboard 和桌面主进程构建通过；检查两个独立 Worker、PDF 字体/CMap/WASM 和原生 Shell 代码均已进入构建输出。

## 仓库验证

完成 Windows 实测发现的修复并最终 rebase 后，`bun run verify:source` 退出码为 0：协议生成检查、生产边界、全工作区类型检查通过；JS 为 **1,877 通过 / 7 跳过 / 0 失败**，Python 为 **1,965 通过 / 4 跳过**。

随后 Windows 实际打包发现资源检查脚本漏导入 `createRequire`，仅补充这一行导入；资源及打包路线的 9 项定向回归通过，继续以实际打包验证该入口，没有重复无关的全量测试。

依赖补丁位于 `config/dependency-patches/`，符合仓库目录约束。Bun/uv 使用 frozen 锁文件。各 worktree 使用自己的 Python 环境，仅复用下载缓存。

最新生产 Dashboard / Electron 构建及资源完整性检查通过。原生 Windows 测试在 Mac 上明确跳过，不计为 Windows 验收。

## Windows x64

验收机：`PC-20240421FADR`。通过 Git bundle 同步分支，由 `wt-claim.ps1` 领取测试 worktree。已取得以下真实结果：

- 定向测试 **19 通过 / 0 失败**，覆盖文件边界、目录分页、历史图片、刷新与释放、串行转换、超时/取消、解析、原生系统应用和资源缺项拒绝。
- 实际 Electron / React 19 界面完成八组场景。使用生产 `app://` 资源处理器，阻断外部请求；PDF 实际创建独立 Worker，切换标签后终止。截图确认中文 Word 内容、公式缓存值 10、前导零 001 正常可见。
- 中文及空格路径的 DOCX、PPTX、DOC、PPT 均转换为 PDF，缓存复用，源文件哈希全部不变。DOCX 缺少 Courier 的诊断保留；损坏文档返回实际 `invalid-document`。
- Windows Shell 返回默认记事本和关联应用图标；私有测试扩展名通过指定应用及 Electron 默认打开，实际收到正确文件路径，文件定位成功。未知扩展名返回空列表，任意应用和移除后的应用均被拒绝。测试结束清理私有注册项。
- 实机发现并修复两处问题：表格 ResizeObserver 同步触发布局循环，改为下一帧合并更新；Shell 全局应用列表包含损坏的无关注册项，改用该文件类型的推荐关联应用。相关系统查询失败仍保留实际异常。

- Windows `Unpacked -Offline` 打包退出码为 0。资源检查确认两个 Worker、PDF 支持资源及许可证齐全；afterPack 使用包内独立 Python/Node 完成 22 项 Office 操作，公式缓存为 10。解包后总体积 1,039.68 MiB，runtime 677.09 MiB，均在现有预算内。
- 将预览服务打包为 Node 模块，再直接使用安装包的 `resources/runtime/node/node.exe` 执行；样本由包内 Python 的 `-I` 隔离模式生成。PATH 只保留包内 Node、Python 和 Windows System32，下载代理设为不可用。四种 Word/PPT 格式的转换、缓存、源文件哈希及损坏文件诊断再次通过。

Windows 测试包位于 `D:\projects\LXE_AGENT\.worktrees\pool-1\dist\desktop-unpacked\win-unpacked\LXE Agent.exe`。本次验证的是解包版应用，不发布安装器或更新渠道；Office 预览所需资源全部随包提供。

## 侧栏完善验收（2026-10-01）

以上记录属于首版。以下记录对应本次阅读状态、文本分页和查看器控件的增量实现；没有更新依赖或数据库结构。

- 状态采用内存中的会话／标签映射。单元测试确认关闭标签、删除会话的清理，以及布局与阅读状态分离。重启仅恢复原有布局。
- 实际 Electron 13 组场景覆盖 Markdown 阅读位置、跨页代码围栏、部分复制、图片缩放、Excel 工作表与 A2 选区恢复、标签打开竞态、方向键导航、关闭／刷新快捷键和窄窗口恢复。目录测试包括 200 项分页、展开目录、滚动恢复、自动移除消失文件及隐藏后的监听释放。
- PDF 夹具包含 20 页及带旋转信息的页面。2 倍设备像素比下确认 400% 实际生成超过 1,600 万像素的画布，且不超过 16,777,216 上限；检查文字可选择、Ctrl+滚轮指针锚点、旋转、第 8 页恢复及 Worker 释放。画布检查要求非空，不能由尚未渲染的页面假通过。
- 文本后端实际读取超过 32 MiB 的日志，覆盖 5,000 行与 2 MiB 边界、超长单行、CRLF、两种 UTF-16 BOM、非法编码、NUL、取消、过期句柄和源文件变化。Windows 剪贴板会将 LF 转为 CRLF，因此同时检查传给剪贴板的原始文本和系统剪贴板中的内容。
- 全量验证曾发现 macOS 延迟／重复文件通知引起的误报。版本号现按设备、inode、大小及修改／变更时间确认实际变化后推进；通知到达本身不会使未变更的文件失效。真实修改、删除和会话归属检查仍生效。
- macOS 真实系统集成返回 TextEdit、15 个关联应用及 15 个图标；Windows 已登录桌面返回记事本、4 个关联应用及 3 个图标。两平台的默认／指定应用、文件定位、工作区打开、无关联扩展名和无效应用拒绝均通过，源文件哈希不变。Windows 临时验收计划任务已清理。
- 使用生产组件的测试截图明确属于测试夹具。未将这些截图作为生产聊天会话截图展示；原生系统集成另由真实桌面 Shell 验证。

最终 rebase 后，修复通知竞态并重新验证：`bun run verify:source` 退出码为 0。协议、生产边界和全工作区类型检查通过；JS **1,882 通过 / 7 跳过 / 0 失败**，Python **1,965 通过 / 4 跳过**。Windows 定向验证 **28 通过 / 0 失败**，包含上述 13 组真实 Electron 界面场景。macOS 最终生产 Dashboard / Electron 构建通过；PDF 和表格仍分别输出按需加载模块。

Windows 最终 `Unpacked -Offline` 构建退出码为 0；资源检查通过，包内 Office Kit 的 22 项操作通过。解包体积 **1,039.71 MiB**，runtime **677.09 MiB**。随后将 PATH 限定为包内 Python／Node 与 Windows System32，并设置不可用的下载代理，使用包内 Python `-I` 创建样本、包内 Node 执行真实预览服务：DOCX、PPTX、DOC、PPT 转换和缓存复用均通过，源文件哈希未变；Courier 缺失字体及损坏文件的 `invalid-document` 原始诊断保留。报告位于 Windows worktree 的 `build/file-preview-polish/packaged-results/report.json`。

将上述包内引擎实际生成的中文 Word PDF 放入 Electron 界面夹具，阻断外部请求后再次通过 13 组场景，确认 PDF Worker、文字和实际像素可用。包内转换与界面查看分别验证，界面夹具不连接真实 Agent 会话 DB。

## 文件失效状态验收（2026-10-01）

本次没有改动依赖、模型工具、会话 DB 或文件格式支持。文件错误改走可序列化结果，详情保留实际诊断；只有目标文件访问的系统错误能触发“文件不存在”或权限不足。

- macOS 和 Windows x64 的真实 Electron 界面均通过 **18 组场景**。新增覆盖批量删除卡片高度不变、无后台通知、失效卡片仍能打开、首次打开不存在后的自动恢复、权限与缺失区别、历史图片保留、PDF Worker 与句柄释放、准备中删除／取消、旧失败不覆盖恢复内容、隐藏后停止轮询，以及应用查询重试和一次性操作提示。明暗主题和长文件名在窄卡片下已检查；应用菜单错误详情可通过方向键和 Enter 展开。
- 两平台使用 `scripts/verify-file-availability.ts`，通过**生产 preload、生产文件 IPC、沙箱 Renderer 和真实文件系统**验收移动、删除、原路径恢复、权限拒绝、失效应用拒绝及缺少引擎。二进制经 IPC 后仍为 `Uint8Array`，历史来源与原文件状态分开；恢复后文件内容哈希一致。
- macOS 真实拒绝读取返回 `EACCES`；Windows 普通权限桌面进程返回 `EPERM`。Windows SSH 管理员进程开启了备份权限，会绕过文件 ACL，因此没有把该进程的读取成功算作权限测试通过；改用已登录桌面的普通权限进程取得真实拒绝结果。测试 ACL 在 finally 中恢复，一次性计划任务已删除。
- Windows 关联查询得到 4 个应用；无效应用产生真实 PowerShell/C# 异常，缺少 Node 产生真实 `spawn … ENOENT`。两者均为未分类操作失败，没有误标为用户文件被删除。下载报告后核对 UTF-8 中文诊断完整，终端代码页显示不影响 IPC 内容。
- 状态单元测试覆盖同文件并发合并、产物／工作区别名共享、迟到请求不能覆盖恢复状态、历史图片与原文件独立，以及删除会话后在途请求不能重建缓存。

最终 rebase 后，`bun run verify:source` 退出码为 0：JS **1,896 通过 / 7 跳过 / 0 失败**，Python **1,965 通过 / 4 跳过**，协议、生产边界与全工作区类型检查通过。随后仅调整 Windows Bun 的真实缺少程序诊断断言，并修正应用菜单的键盘焦点；分别补做定向断言、类型检查和两平台的 18 组 Electron 回归，没有重复无关的完整测试。Windows 初轮 35 项定向测试中 34 项通过，剩余一项在适配实测诊断后单独复验通过。两平台最终 Dashboard／桌面生产构建通过。

界面截图是**生产组件组成的测试夹具**，不是实际聊天截图。测试截图命名为 `missing-files-light-test-fixture.png`、`missing-files-dark-narrow-test-fixture.png`、`applications-error-test-fixture.png`；原生文件状态另由实际文件／ACL 及 IPC 验收。Windows 报告位于验收 worktree 的 `build/file-availability/native-interactive/report.json`。
