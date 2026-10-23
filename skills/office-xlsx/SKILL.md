---
name: office-xlsx
description: 创建、读取和修改 Excel 工作簿（.xlsx），处理数据、公式、样式和 pandas 分析，以及按需重算公式、生成区域图片和导出 PDF。用于表格文件输入或交付。
---

# Excel 工作簿

通过 `exec` 使用 `uv run --frozen python`，环境已提供 openpyxl、pandas 和 Pillow。脚本、检查报告和最终文件放在当前 `artifact_root/office/<任务目录>/`。路径相对调用工作目录解析，含空格路径分别加引号。默认另存新文件；用户明确要求时可以原地修改。

## 读取与修改

修改前检查工作表名称、目标单元格类型、公式、样式、合并区域及引用范围。用 openpyxl 定向修改已有工作簿，保留公式时使用 `data_only=False`。保存后重新打开，检查改动范围与需要保留的其他工作表、数据和格式。

pandas 适合分析和整理数据。DataFrame 不包含完整工作簿结构；把分析结果用 openpyxl 写回指定范围，避免一次导出丢掉其他工作表、公式、图表或样式。保持数字、日期、布尔值与字符串标识符的原意；数字格式不等于类型转换。

openpyxl 写入公式后不会计算结果。`data_only=True` 读取的是缓存值，可能为空或过期。需要刷新计算结果时，用下方 `recalculate` 生成新工作簿，再分别以 `data_only=False` 和 `True` 读取，校验公式与结果。重算不能代替业务逻辑检查，也不保证 Excel 专有特性完全兼容；不要用常量替换用户要求的公式。

`.xls`、`.xlsb`、加密文件不能通过改扩展名变成 XLSX。先确认引擎支持的格式和操作。XLSM 的 `keep_vba=True` 只保留 VBA 包内容，不执行或修改宏；对透视表、外部链接和其他高级特性，保留原文件并核实具体保留要求。

## 检查与交付

保存后重新用 openpyxl 打开，结合任务源数据检查工作表、关键数值、类型、公式和合计。需要检查特定单元格或工作表数量时，在任务脚本中编写对应断言。重算后分别以 `data_only=False` 和 `True` 检查公式及缓存结果。

数据处理、公式和普通样式（加粗表头、数字格式）完成适用的数据检查即可交付。涉及排版、图表外观、打印布局或显示问题时，对相关区域做视觉检查。先确认当前模型支持图片输入，再生成预览并通过 `read` 查看。模型不支持图片时仍可完成请求的图片/PDF 导出，但应说明无法完成所需的视觉检查。

确认预览包含目标内容，空白或损坏的图片不能作为视觉检查通过的证据。只在用户要求打印布局时修改打印区域和缩放设置。检查通过后用 `send_files` 交付真实最终文件路径，默认只交付所需文档，不包含中间脚本和报告。

## 内置 Office 引擎

```sh
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" capabilities --json
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" recalculate --input "结果.xlsx" --output "结果-已重算.xlsx"
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" render --input "结果.xlsx" --output-dir "预览-v1" --sheet "汇总" --range A1:H25 --dpi 144
"$LXE_OFFICE_NODE" "$LXE_OFFICE_CLI" convert --input "结果.xlsx" --output "结果.pdf"
```

上述命令适用于 macOS 的 shell；Windows PowerShell 使用 `& $env:LXE_OFFICE_NODE $env:LXE_OFFICE_CLI`，后接相同参数。宿主通过这两个环境变量提供内置 Node 和 Kit CLI 的绝对路径，直接经 `exec` 调用。

需要引擎操作时先读取一次能力信息。失败时保留实际错误和可用源文件，不自动切换系统 LibreOffice。参数、输出和退出码沿用 Kit CLI，可用 `--timeout-ms` 设置超时。输出文件或目录必须尚不存在；检查新结果后再按用户原地修改要求替换原文件。

工作表图片使用精确表名和单元格范围，涵盖需要检查的图表或绘图区域；`--pages` 用于物理页面，不代表工作表编号。PDF 遵循打印设置。读取返回的 manifest、分片位置和缺失字体诊断；较大区域可能分为多张图片。复用同一版文件的预览，修改源文件后再按需更新。渲染不会刷新原工作簿中的公式缓存。
