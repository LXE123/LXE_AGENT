---
name: office-pptx
description: 创建、读取和修改 PowerPoint 演示文稿（.pptx），处理幻灯片、文字、图片、表格和图表，检查结构，并按需渲染幻灯片或导出 PDF。用于 PPT 文件输入或交付。
---

# PowerPoint 演示文稿

通过 `exec` 使用 `uv run --frozen python`，环境已提供 python-pptx 和 Pillow。脚本、检查报告和最终文件放在当前 `artifact_root/office/<任务目录>/`。路径相对调用工作目录解析，含空格路径分别加引号。默认另存新文件；用户明确要求时可以原地修改。

## 读取与修改

修改前检查页面尺寸、幻灯片顺序、布局、母版、形状、文字、图片、表格和图表。用 python-pptx 定向修改，保持需要保留的主题、对象和几何位置。新建时先确定页面比例、布局及字体，再放置内容。

文字分布在 text frame、段落和 run 中；整体赋 `.text` 会重建文本并丢失局部格式。保留格式时修改相关 run，检查项目符号、段间距和文本框尺寸。图片保持比例，图表修改后核对类别、系列及嵌入数据，不能只检查标题。

python-pptx 对动画、切换、SmartArt、嵌入对象及某些图表没有完整编辑支持。保留源文件并检查任务要求的重要对象和关系；不要因为这些对象不在便捷 API 中就重新构建整份演示文稿。旧 `.ppt`、宏和加密文件需先确认受支持的处理方式，改扩展名不能完成转换。

## 检查与交付

保存后重新用 python-pptx 打开，根据任务核对页数、顺序、文字、图片、图表系列与数据。需要检查特定文字或数量时，在任务脚本中编写对应断言；结构和内容检查不能判断对象遮挡、字体溢出或图表外观。

根据改动和排版要求检查相关幻灯片，关注文本溢出、对象重叠、对齐、对比度、图片比例和图表可读性。模型支持图片输入时用 `read` 查看生成图片；不支持时完成其他检查，说明所需视觉检查的限制。确认预览包含目标内容，空白或损坏的图片不能作为视觉检查通过的证据。

检查通过后用 `send_files` 交付真实最终文件路径，默认只交付所需文档，不包含中间脚本和报告。

## 内置 Office 引擎

```sh
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" capabilities --json
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" render --input "结果.pptx" --output-dir "预览-v1" --pages 1,3 --dpi 144
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" convert --input "结果.pptx" --output "结果.pdf"
```

上述命令适用于 macOS 的 shell；Windows PowerShell 使用 `& $env:LXE_OFFICE_NODE $env:LXE_OFFICE_CLI`，后接相同参数。宿主通过这两个环境变量提供内置 Node 和 Kit CLI 的绝对路径，直接经 `exec` 调用。

需要引擎操作时先读取一次能力信息。失败时保留实际错误和可用源文件，不自动切换系统 LibreOffice。参数、输出和退出码沿用 Kit CLI，可用 `--timeout-ms` 设置超时。输出文件或目录必须尚不存在。`--pages` 从 1 开始，省略则渲染全部幻灯片。

读取返回 manifest 的图片路径和缺失字体诊断，使用系统已安装字体及引擎附带资源。复用同一版文稿的预览，源文件变化后再按需更新。静态图片/PDF 无法验证动画、切换和交互效果，也不保证与 Microsoft PowerPoint 的显示完全一致。
