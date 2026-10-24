# 定时任务页面的 CDS 适配与验收

本页覆盖定时任务列表、详情、编辑弹窗及其实际控件状态。依据是仓库的 [CDS 指南](guide.zh-CN.md)、[原文](sources/cds-tokens-vanilla.original.md)和[字段状态证据](sources/ion-settings/evidence-excerpts.json)。布局、尺寸和业务行为属于 LXE 适配，不宣称取得了 Claude 定时任务页面的专用规范。

生产入口：[AutomationsPage.tsx](../../../apps/dashboard/src/features/automations/AutomationsPage.tsx)、[时间表单](../../../apps/dashboard/src/features/automations/ScheduleFields.tsx)、[页面样式](../../../apps/dashboard/src/features/automations/theme.css)、[共享主题](../../../apps/dashboard/src/shared/cds-theme.css)。

## 规则和实际实现

| 部分 | 规则与实现 |
| --- | --- |
| 页面、弹窗 | 外层 content-panel 统一管理 panel 背景和留白，标题、内容宽度对齐“能力”页，内部不再叠加内边距。弹窗使用 popover；暗色表面分别为 `#1a1a19` 和 `#232322`，是项目既有配方。遮罩和阴影引用共享语义变量。字段焦点的隔离环跟随所在表面。 |
| 文字 | 主内容使用主文字；操作说明使用 secondary；时间戳等元数据和占位符使用 muted。禁用文字使用独立 `--cds-disabled-ink`，不再对整个控件降透明度。 |
| 字段 | 默认 `--cds-field` 背景、`--border` 边界；悬停增强边界；键盘焦点使用表面隔离环和 accent 环。输入框、下拉框、文本域共用规则；原生单选框和复选框单独处理，排除选择器不增加状态规则的优先级。 |
| 时间安排 | 基础区保留选填名称、提示词和重复／时间；高级区收起对话、模型、思考强度、时区与开始日期。日期使用应用日历，时间使用 24 小时／分钟选择器。标签和控件逐行排列，以浅分隔线组织内容。周几使用原生复选框，选中背景不被悬停覆盖。没有规则字符串输入框，无法完整映射的旧计划提供保留说明与重设操作。 |
| 错误 | 必填项、原生范围校验通过 `:user-invalid` 显示危险边界；错误焦点使用危险环，悬停不覆盖错误。服务端错误保留真实文字，以危险背景和前景成对展示，不猜测错误属于哪个字段。 |
| 禁用 | 填充为 alpha-1，文字为 alpha-4 对应的专用变量；控件本身 opacity 为 1。禁用时不响应悬停，也不接受输入。离线、处理中、计划结束分别提供原因。 |
| 列表 | 选中使用共享 `--cds-selected`；悬停、焦点、按下均不抹掉选中背景。选中由 `aria-pressed` 表达，键盘焦点另外显示。 |
| 操作按钮 | 有任务时，标题栏“新建任务”使用小尺寸描边按钮。无任务时，整页空状态只保留一个实心“新建任务”入口。弹窗仅“保存任务”为实心主操作。删除确认使用危险前景和浅危险悬停背景。 |
| 弹窗键盘 | 原生 modal dialog 阻止背景交互；打开聚焦名称，Tab 在控件间循环，Escape 关闭并恢复打开按钮焦点。请求期间字段和按钮禁用，Escape 不丢弃正在处理的表单。 |
| 页面状态 | 有任务时保留左侧列表与右侧详情；没有任务时隐藏搜索、筛选和分隔线，显示整页空状态。创建第一个任务后切换为双栏并选中它，删除最后一个后回到空状态。加载、加载错误和搜索无匹配分别展示；无匹配时不继续显示被过滤的任务详情。运行记录请求失败不显示“首次运行”提示。 |
| 窄屏 | 双栏在窄屏改为上下布局；长名称和诊断可换行，弹窗限定在视口内，表单内容独立滚动，标题和保存栏保持可见；保存按钮可通过键盘到达。 |

共享禁用变量采用原文用途关系，数值映射是 LXE 适配。其他页面仍保留原有禁用样式；本次没有将整个产品宣称为完成 CDS 迁移。

## 可重复验收

从仓库根执行：

```sh
bun run cds:check:automations
```

检查使用本地 Electron 加载**完整生产桌面布局、导航和 React 页面**，复用行为测试的桌面接口 fixture，配合内存数据库与模拟执行。切换“能力”与“定时任务”，比较标题位置和排版，并检查内容画布是否贴合导航与窗口边界，避免单独渲染页面时漏掉双重内边距。鼠标、Tab、方向键、输入、提交等操作触发真实控件状态，不给 DOM 强制添加 hover/focus 类。系统原生下拉弹出层不在离屏窗口中操作，选项通过 `change` 事件进入生产表单处理；其焦点／悬停仍由真实输入触发。测试中的错误带 `Fixture:` 前缀，只有测试传输层会产生。

结果按平台保存：[macOS 报告](showcase/automations/verification.json)、[Windows 报告](showcase/automations/windows/verification.json)。报告包含平台、架构、实际计算样式、断言组、截图列表和受验源码的 SHA-256。指纹按 UTF-8 / LF 计算，避免 Windows checkout 的 CRLF 换行造成误差。Windows 输出到 `windows/`，保留 macOS 证据。每次启动先将当前平台报告标为 running，失败则标为 failed，避免将旧截图或旧成功结果误当本轮通过。

| 亮暗主题均覆盖 | 组合 |
| --- | --- |
| 字段 | 默认、悬停、焦点、悬停＋焦点、输入后搜索；错误、错误＋焦点、错误＋悬停、修正后恢复 |
| 列表与按钮 | 选中、选中＋悬停、选中＋焦点、三者叠加；新建按钮默认／悬停／按下；空状态主按钮；删除确认；禁用＋悬停、点击与 Tab 跳过 |
| 编辑器 | 初始焦点、正反 Tab 边界、背景不可聚焦、Escape 与焦点恢复；高级选项折叠与展开、工作区无隐式默认；下拉框和文本域焦点；请求期间字段／按钮禁用以及恢复 |
| 时间表单 | 各预设与一次性／间隔通过真实调度器预览；自定义周期、多执行日、复选框键盘与焦点、无效间隔／空执行日阻止保存、修改后清除旧预览；高级日历修改开始日期后旧预览消失，重新预览并保存新时间；保存回读、旧组合计划无损编辑及明确重设 |
| 内容与布局 | 完整桌面画布、与“能力”页的标题对齐；整页空状态、首次创建、最后删除、无匹配、加载、查询失败、保存失败；390px 窄屏空状态、双栏折叠及弹窗 |
| 自动命名与思考强度 | 留空名称保存后后台更新、不创建执行；手写名称保留；思考强度保存回读，切换不支持思考的模型时清空并禁用，沿用对话继承设置 |
| 过期恢复 | 空时间初始焦点、必填与未来时间校验、取消、保存期间禁用、实际错误与重试；停止执行不暂停计划 |

截图：[亮色页面](showcase/automations/page-light.png)、[暗色页面](showcase/automations/page-dark.png)、[亮色编辑器](showcase/automations/editor-light.png)、[暗色编辑器](showcase/automations/editor-dark.png)。其余错误、空白和窄屏截图见同目录。

Windows 截图：[亮色页面](showcase/automations/windows/page-light.png)、[暗色页面](showcase/automations/windows/page-dark.png)、[亮色编辑器](showcase/automations/windows/editor-light.png)、[暗色编辑器](showcase/automations/windows/editor-dark.png)。本轮结果以报告中的通过状态、计数和源码指纹为准，包含“能力”页对照、窄屏空状态、自动命名、思考强度和过期恢复表单；Windows 源码与进程验收范围见[实机记录](../../desktop/automations-windows-validation.md)。

可视化时间表单截图：[亮色](showcase/automations/schedule-light.png)、[暗色](showcase/automations/schedule-dark.png)、[Windows 亮色](showcase/automations/windows/schedule-light.png)、[Windows 暗色](showcase/automations/windows/schedule-dark.png)。

创建表单的重复选项、日历和时间弹层使用应用组件，通过真实鼠标和键盘验收。方向键移动、Enter 选择，Escape 只关闭当前弹层并恢复触发按钮焦点。其余 select、复选框及过期恢复弹窗的日期输入保留系统渲染。完整读屏、触屏和所有原生弹出层尚未验收。功能检查和截图不能证明上游规则本身正确，也不能代表全站组件的完整验收。

新建表单与应用日历：[暗色基础区](showcase/automations/editor-basic-dark.png)、[亮色日历](showcase/automations/calendar-light.png)、[暗色时间选择](showcase/automations/time-dark.png)。
