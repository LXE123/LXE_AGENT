# Office 接口简化与 Kit 0.1.5 验收

日期：2026-10-20。实现提交 `50cbac1e`，运行中取消与关闭验收补充提交 `1bf3f17e`。

## 本次变化

- Electron 文件预览通过 Kit Node API 复用 Converter，保留队列、缓存、取消及源文件保护。
- 模型按三个 Office Skill 直接通过 `exec` 调用 Kit CLI。
- lxeskillCLI 保留私有 Kit CLI 适配和业务校验；删除公共 `shared.office` 入口及通用检查器。
- Kit 与配套原生引擎从 0.1.3 固定升级至 0.1.5。

## 已执行验证

| 检查 | macOS arm64 | Windows x64 |
| --- | --- | --- |
| 预览、资源定向 JS 测试 | 27 通过 | 27 通过 |
| 私有适配、越南备货重算测试 | 75 通过、2 项平台跳过 | 75 通过、2 项平台跳过 |
| Kit CLI 真实文件验收 | 通过 | 通过 |
| 私有适配调用真实引擎重算 | 通过，公式保留、缓存结果为 10 | 通过，公式保留、缓存结果为 10 |
| Electron 主进程 Node API | 通过 | 通过 |
| 文件服务读取 `.docx`、`.pptx`、`.doc`、`.ppt` | 通过 | 通过 |

两平台均使用 Electron 43.7.0（内嵌 Node 24.21.0）。Windows 主机为 `PC-20240421FADR`，在独立 worktree 和其自己的虚拟环境中运行测试，没有复用其他 checkout 的 `.venv`。

CLI 验收覆盖中文及空格路径、内容与格式保留、PDF 和图片、重算、拒绝覆盖输入及已有输出、损坏文件、引擎缺失、超时和取消。已查看两平台生成的中文文档与图表图片。

Node API 验收直接使用生产预览适配，验证缓存复用、原文不变、真实错误、转换运行中取消、取消后恢复，以及关闭服务时中止正在运行的转换并清理临时文件。Windows Word 样本返回缺失字体 `Courier`，诊断原样保留，转换成功。

## Windows 打包

`bun run desktop:pack:win` 通过。首次构建时先补建了脚本所需的 `dist/agent-cli` 输出目录，未修改构建脚本。

解包产物的 afterPack 使用随包 Python 和 Node、清除开发环境 PATH 后完成 20 项真实 Office 操作验证，结果通过。随后用 Electron 主进程加载实际包内的 Kit 资源，再次验证 API 预览、取消、恢复、超时与关闭清理，结果通过。包内确认没有旧 `shared/office/__main__.py` 和 `check.py`，私有业务适配存在。

## 合并前检查

- 协议生成、TypeScript 边界检查、全部工作区类型检查和桌面主程序构建通过。
- 全量 JS：2218 通过、10 跳过、1 失败。失败项是未修改的 `Chromium renderer behavior: windows-menu`，选择文本断言未满足；单独复测 1 项通过，未修改该测试或对应功能。
- 全量 Python：2428 通过、14 跳过。因 JS 阶段失败导致组合命令提前退出，Python 阶段另行完整执行一次。
- 此后补强真实 API 验收脚本，并在两平台执行通过，另做空白格式整理；功能实现未变化，没有重复全量测试。
- Obsidian 四篇架构笔记已更新，五篇关联笔记中的 20 处双链与标题引用均验证有效。

## 证据

本机主工作区保留 `build/office-integration-validation/`：

- `macos/cli/`：CLI 诊断、报告和真实文件；业务适配重算结果另存于同目录。
- `macos/api-active-cancel/report.json`：真实 Electron API 验收。
- `macos/service/report.json`：新旧 Word/PPT 文件服务验收。
- `macos/verify-source.log`、`macos/verify-python.log`：全量检查日志。
- `windows/cli/`、`windows/api/report.json`、`windows/service/report.json`：Windows 实测产物与报告。
- `windows/package.log`、`windows/packaged-api-report.json`：Windows 解包构建、随包 CLI 与包内资源 Node API 验收。

重跑入口见 [Office 文件能力](../office-runtime.md) 和 [文件预览侧栏](../desktop/file-preview.md)。本记录描述开发环境、Windows 解包产物及文件处理验收；不代表重新验证了安装器、系统缺失 VC++ 的安装流程或所有 Office 格式特性。
