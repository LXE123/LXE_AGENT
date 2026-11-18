---
name: office-pdf
description: 读取 PDF 的文字和表格、处理扫描页，合并、拆分和旋转页面，填写并校验 PDF 表单，渲染页面检查版式，以及经 Word 生成新 PDF。用于 PDF 文件输入或交付。
references:
  - references/forms.md
---

# PDF 文档

通过 `exec` 使用 `uv run --frozen python`，环境已提供 pypdf、pdfplumber 和 Pillow。`read` 不能打开 PDF，PDF 一律交给 Python 读取；需要看页面时用内置引擎渲染成 PNG，再用 `read` 查看图片。脚本、预览和最终文件放在当前 `artifact_root/office/<任务目录>/`；只回答问题时不必生成文件。路径相对调用工作目录解析，含空格路径分别加引号。默认另存新文件，保留原 PDF。

## 读取文字与表格

先看页数、是否加密和每页能提取到多少文字，再决定怎么读。pdfplumber 按页提取文字（`page.extract_text()`）、单词坐标（`extract_words()`）和表格（`extract_tables()`）；pypdf 适合快速取文字、页数、元数据和书签。加密文件向用户要密码后用 `PdfReader.decrypt()` 打开，不尝试其他方式。

回答问题前读完相关页的完整内容，连同标题、表头、单位和脚注一起看，不要只截一句。引用位置写文件名和页码。PDF 的物理页序（从 1 开始）和页面上印的页码不同时，两者都写，例如“第 5 页（PDF 第 7 页）”，方便用户在阅读器里直接翻到。

`extract_tables()` 依赖表格线，无框线表格常返回空列表。这时用 `extract_words()` 按坐标归列，或把 `table_settings` 的 `vertical_strategy`/`horizontal_strategy` 设为 `"text"`。跨页表格、合并表头和多行单元格容易错列，把提取结果和该页渲染图对照，核对列归属、单位和合计。

## 扫描页

某页 `page.chars` 为空或文字明显少于页面内容，而 `page.images` 不为空，说明是扫描页或图片页，文字提取拿不到内容，环境里也没有 OCR 引擎。渲染这些页，用 `read` 看图读取，并在答案中说明哪些内容来自看图识别、哪些数字需要用户复核。模型不支持图片输入时，说明哪些页无法读取，不根据相邻页推测内容。

## 生成与编辑

新建 PDF 先用 python-docx 写成 Word（做法见 office-docx），再用下方 `convert` 导出；Excel 和 PPT 同理。引擎自带字体并报告缺失字体，中文不用另行配置。不要用 Pillow 把文字画成图片拼成 PDF。

合并、拆分、抽页、调整顺序、旋转和书签用 pypdf 的 `PdfWriter` 完成。写出后重新打开，核对页数、页序、旋转角度，并抽查关键页文字。引擎只能把 Office 文件转成 PDF，不能把 PDF 转回 Word 或 Excel；用户需要可编辑版本时，先说明只能按提取内容重建，版式不会一致。

## 表单

填写交互表单前读 [references/forms.md](references/forms.md)：用 pypdf 同时写好字段值和页面外观，默认保留可编辑表单，交付前重新打开核对两者。渲染图只能证明版式：外观缺失时，引擎会按字段值补画，图上看起来正常；外观里的字写坏时，图上能看到问号或方块。

## 检查与交付

保存后重新打开结果，按任务核对页数、页序、关键文字和表单字段；需要断言特定内容时写在任务脚本里。生成或修改 PDF 后，渲染受影响的页面并用 `read` 查看，看过再交付，之后每改一次再看一次；页数多时看每份来源的首页、改动过的页和最后一页。只回答问题时不需要。确认预览里有目标内容，空白或损坏的图片不能算视觉检查通过；模型不支持图片输入时，说明哪些视觉项没有核验。

检查通过后用 `send_files` 交付真实最终文件路径，默认只交付所需文件，不包含中间脚本、预览和报告。

## 内置 Office 引擎

```sh
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" capabilities --json
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" render --input "文件.pdf" --output-dir "预览-v1" --pages 1,3 --dpi 144
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" convert --input "文件.docx" --output "文件.pdf"
```

上述命令适用于 macOS 的 shell；Windows PowerShell 使用 `& $env:LXE_OFFICE_NODE $env:LXE_OFFICE_CLI`，后接相同参数。宿主通过这两个环境变量提供内置 Node 和 Kit CLI 的绝对路径，直接经 `exec` 调用。

`render` 直接接受 PDF，用 PDFium 出图；`--pages` 是从 1 开始的物理页序，省略则渲染全部页面。输出目录必须尚不存在，同一版文件的预览可以复用。失败时保留实际错误和源文件，不自动切换系统 LibreOffice 或其他 PDF 工具；可用 `--timeout-ms` 设置超时。
