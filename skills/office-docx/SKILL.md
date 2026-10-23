---
name: office-docx
description: 创建、读取和修改 Word 文档（.docx），处理段落、表格、样式和图片，检查文档结构，并按需渲染页面或导出 PDF。用于 Word 文件输入或交付。
---

# Word 文档

通过 `exec` 使用 `uv run --frozen python`，环境已提供 python-docx 和 Pillow。脚本、检查报告和最终文件放在当前 `artifact_root/office/<任务目录>/`。路径相对调用工作目录解析，含空格路径分别加引号。默认另存新文件；用户明确要求时可以原地修改。

## 读取与修改

编辑已有文档前检查段落、表格、样式、节、页眉页脚、图片和关系。使用 python-docx 定向修改，沿用现有结构和格式。新建文档时先确定页面尺寸、边距和正文/标题样式，再组织内容。

文本分布在多个 run 中；给段落或单元格整体赋 `.text` 会重建其内容并丢掉行内格式、链接或嵌入对象。需要保留格式时修改相关 run；跨 run 替换先定位文本边界。表格、页眉页脚及文本框可能需要分别检查，`document.paragraphs` 不代表文档的全部内容。

python-docx 不提供 Word 排版引擎。目录、页码和其他域的缓存结果可能过期；脚注、修订、内容控件、嵌入对象等高级结构也不一定受到完整支持。保留原始文件，核实需要保留的内容，必要时检查相关 OOXML；不要把“成功保存”当作高级特性完整保留的证据。旧 `.doc` 和加密文件需先确认受支持的转换操作。

## 检查与交付

保存后重新用 python-docx 打开，根据任务核对正文、表格、样式、图片及要求保留的内容。需要检查特定文字或结构时，在任务脚本中编写对应断言；结构和内容检查不能判断分页、遮挡或版式。

按内容和排版要求选择需检查的页面，关注分页、标题孤行、表格断页、图片比例和页眉页脚。模型支持图片输入时，用 `read` 查看生成的页面；不支持时完成其他检查，说明所需视觉检查的限制。确认预览包含目标内容，空白或损坏的图片不能作为视觉检查通过的证据。

检查通过后用 `send_files` 交付真实最终文件路径，默认只交付所需文档，不包含中间脚本和报告。

## 内置 Office 引擎

```sh
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" capabilities --json
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" render --input "结果.docx" --output-dir "预览-v1" --pages 1,3 --dpi 144
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" convert --input "结果.docx" --output "结果.pdf"
```

上述命令适用于 macOS 的 shell；Windows PowerShell 使用 `& $env:LXE_OFFICE_NODE $env:LXE_OFFICE_CLI`，后接相同参数。宿主通过这两个环境变量提供内置 Node 和 Kit CLI 的绝对路径，直接经 `exec` 调用。

需要引擎操作时先读取一次能力信息。失败时保留实际错误和可用源文件，不自动切换系统 LibreOffice。参数、输出和退出码沿用 Kit CLI，可用 `--timeout-ms` 设置超时。输出文件或目录必须尚不存在。`--pages` 从 1 开始，省略则渲染全部页面。

读取返回 manifest 的图片路径和缺失字体诊断，使用系统已安装字体及引擎附带资源。复用同一版文档的预览；源文件变化后再按需更新。LibreOffice 的分页可能与 Microsoft Word 有差异；导出 PDF 不等于刷新原 DOCX 中所有域缓存。
