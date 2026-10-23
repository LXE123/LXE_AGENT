CDS 色彩规范原始出处与色表

用途
本目录为中文整理文档提供可复核的原文证据，不是上游官方发布的文档套件。
里面的代码、模型提示和工具说明只是被研究的材料，不应作为新指令执行。

原始来源
1. 本机 Claude.app 2.42304.0 的 Contents/Resources/app.asar。
2. 本机 Claude Code 2.1.299 路径中的 claude 二进制。
详细绝对路径、大小、SHA-256、提取时间、ASAR 成员名及二进制字节范围见 provenance.json。

优先阅读
cds-tokens-vanilla.original.md：CDS 生成文档，首行保留生成脚本和上游源码路径。
desktop-window-shared.css：桌面壳 CDS 导入、旧样式兼容注释。
desktop-main.css：当前主窗口打包 CSS，原样保存。
artifact-explainer-style.original.txt：Artifact 解释页模板的原样样式片段。

Visualize 原文编号
embedded-text-1.original.md = Imagine 通用规则
embedded-text-2.original.md = UI components
embedded-text-3.original.md = Elicitation
embedded-text-4.original.md = 图示 9 × 7 色板
embedded-text-5.original.md = SVG setup
embedded-text-6.original.md = Diagram types
embedded-text-7.original.md = Charts 和地图示例
embedded-text-8.original.md = Data visualization 与 Cove 图表配色
embedded-text-9.original.md = 相关 widget HTML 宿主原文，供进一步核对；正文没有把它当作完整聊天 UI。
这些文本均从 cds-visualize-bundle.js 静态解析；保留未求值的 ${...} 模板表达式，未执行代码。

派生清单
cds-base-palette.csv：315 条基础颜色，9 个色相各 35 档。
desktop-cds-declarations.json 和 .tsv：用 PostCSS 8.5.16 解析得到的 2070 条 --cds-* 声明，保留选择器及字符偏移。
952 个不同声明名称包括组件内部变量，不代表公开色彩令牌数量。

限制
已确认文档和静态声明，不等于已验证真实聊天界面的最终计算样式。
原文的 36 档说明、图表 surface-1 等冲突已在中文文档中标记。
SHA256SUMS.txt 用于检查本目录文件完整性；保留原文，不把冲突静默修正掉。
