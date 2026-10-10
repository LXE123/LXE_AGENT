# Office 文件能力

三个独立 skill 位于 `skills/office-xlsx`、`skills/office-docx`、`skills/office-pptx`。现有 skill 加载器按需读取正文，Agent 用已有的 `exec` 执行 Python、`read` 查看图片、`send_files` 交付文件。没有新增模型工具或 `lxeskill` 业务命令。桌面内查看文件的交互见[文件预览侧栏](file-preview.md)。

## 分工与入口

openpyxl 读写工作簿，pandas 分析数据，python-docx 和 python-pptx 修改文档；LibreOffice Kit 负责重算、转换和渲染。它们都随桌面运行环境准备，操作文件时不再下载依赖。

```text
uv run --frozen python -m shared.office check "文件.xlsx" --out "检查.json" --contains "汇总" --count 2
uv run --frozen python -m shared.office capabilities --json
uv run --frozen python -m shared.office recalculate --input "文件.xlsx" --output "已重算.xlsx"
uv run --frozen python -m shared.office render --input "文件.docx" --output-dir "页面预览" --pages 1,3
uv run --frozen python -m shared.office convert --input "文件.pptx" --output "文件.pdf"
```

`check` 使用移植的 dsh 检查器，支持文本、数量断言；数量只适用于工作表和幻灯片。它不计算公式，也不判断外观。其他操作直接透传 Kit CLI 的参数、输出、错误和退出码，路径相对调用工作目录解析。可用 `--timeout-ms` 设置引擎超时；输出文件和预览目录必须是新路径。

越南备货内部通过 `shared.office.execution` 调用重算，明确给 Kit 300 秒计算时间，再预留 5 秒退出时间。仍未退出时，macOS 先请求正常退出并最多等待 5 秒，然后结束本次任务的独立进程组；Windows 结束本次任务的 Job Object，包含仍存活的子进程。取消也清理本次任务，不按程序名结束其他 Office 进程。重算后的工作簿仍须通过原有校验才会交付，公式和业务规则不变。

宿主通过 `LXE_OFFICE_NODE` 和 `LXE_OFFICE_CLI` 提供绝对路径。桌面和一次性 Agent CLI 都使用同样的资源布局；skill 不参与安装位置解析。打包后的 `exec` 会把 `uv run --frozen python` 映射到随包 Python，不要求用户安装 uv。

最终文件位于当前 `artifact_root/office/<任务目录>/`，默认另存。数据检查、公式重算和视觉检查按任务需要分别执行；成功退出不能证明图片里有实际文档内容。

## 开发与依赖更新

macOS 开发机需要独立 Node >=22.19，运行：

```sh
uv sync --frozen
bun run office:prepare
uv run --frozen python scripts/verify-office-runtime.py --runtime-root build/desktop-runtime/darwin-arm64
```

Intel Mac 把最后一个目录换成 `darwin-x64`。`desktop:dev` 和 `desktop:preview` 会自动准备 Office 资源。准备脚本将独立 Node 放入开发运行目录；应用不使用 Electron 内嵌 Node 执行 Kit。

Kit 固定为 `0.1.3`；原生平台引擎版本由它的依赖声明决定，Windows x64 和 macOS 均为 `0.1.3`。Office 有独立的 `config/desktop-runtime/office/package.json` 和 `bun.lock`，避免把数百 MB 的引擎装入主 JS 工作区。新增依赖用 Bun 锁定，构建始终执行 frozen 安装。Python 依赖通过根 `uv.lock` 同时进入开发环境和桌面 Python。

引擎及其程序资源、字体、许可证、来源材料整体保留，按上游 `prebuilds.json` 逐文件校验。构建缺少或损坏引擎即失败，运行时也不会自动寻找系统 LibreOffice。

## Windows 打包

复用现有 `bun run desktop:runtime:win`、`desktop:pack:win` 和 `desktop:dist:win`。资源布局新增 `resources/runtime/office/`，共用 `runtime/node/node.exe` 和随包 Python。共享检查器位于项目 wheel 的 `shared/office` 内。

Office 的 manifest、锁文件、VC++ 安装器锁及准备脚本进入运行时缓存指纹，旧缓存不能直接复用。资源范围清单保留 Office 完整依赖。`afterPack` 使用随包 Python/Node、清除开发机 PATH 并运行实际文件验收，检查失败会阻止安装器构建。

安装器携带 Microsoft VC++ v14 x64 Redistributable，检测版本，不足时通过系统提权安装；退出码 3010 设置重启标记。拒绝提权、安装失败或安装后版本不符都会中止并显示诊断及日志位置。程序运行时无需下载安装器。版本、不可变下载 URL 和 SHA-256 位于 `vc-redist.lock.json`；更新时同步 `office-prerequisites.nsh` 的最低版本。

## 验收

`scripts/verify-office-runtime.py` 创建并定向修改带中文和空格路径的三类真实文件，验证内容和格式保留、公式缓存、结构检查、PDF 与图片、已有输出、损坏文件、引擎缺失、超时及取消。预览检查统计主要背景色之外的像素，避免把一个异常像素误当作有效内容；仍需人工查看中文、表格和图表。

每次验收保留 `diagnostics.json`、产物和 `report.json`；报告记录当前解释器路径，区分开发环境与实际随包环境。原始 Kit 的缺失字体诊断保留在操作结果中。VC++ 缺失场景需在干净环境验证，或在明确授权后进行受控卸载、安装和恢复测试，并记录实际安装退出码与重启要求。
