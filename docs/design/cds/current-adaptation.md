# 当前 CDS 适配总表

整理日期：2026-10-20。本表：设置原生输入框、会话导航行、工具调用条；定时任务页面的独立状态矩阵与实测见 [定时任务适配](automations.md)。不是全站审计，也不是 Claude 全组件规范。

本表由 `current-adaptation.json` 生成。JSON 维护状态与证据对应关系；当前样式以链接的生产源码为准，历史变化通过 Git 查阅。

## 如何打开与验证

从仓库根执行 `bun run cds:preview`，打开输出的本地网址。页面并排展示亮暗主题，可输入、选择、Tab 聚焦和展开工具结果；预览 10 分钟后自动关闭，也可 Ctrl+C 结束。
执行 `bun run cds:check` 会构建相同页面、运行本地 Electron 交互检查、保存截图和实测值，并关闭测试进程。命令失败时不得沿用旧记录声称通过。
执行 `bun run cds:docs` 可从 JSON 重建本表。

入口源码：[展示页](../../../apps/dashboard/test/behavior/cds-gallery.tsx)、[布局样式](../../../apps/dashboard/test/behavior/cds-gallery.css)、[构建与验证](../../../scripts/cds-gallery.ts)。
实测记录：[verification.json](showcase/verification.json)。记录内含实际源码 SHA-256、构建时 HEAD、浏览器版本与检查结果；后续代码改变需重新验证。

## 证据等级

- **原规则**：已取得文档明确说明；不外推到所有 Claude 页面。
- **实现证据**：归档资源的具体代码与位置；没有抓取到的 Claude 运行时行为仍待验证。
- **LXE 实测**：当前本地组件在示例数据下的计算样式与行为；不证明上游规则。
- **探针**：为了暴露缺口而附加的原生属性；不代表生产流程已经支持。

上游版本：Claude.app 2.42304.0（已归档资源；未重新抓取当前安装版本）。

- **S1 · 原规则**：[原文件](sources/cds-tokens-vanilla.original.md)，定位 `Token rule / Muted text rule / Purpose tokens`。生成的 CDS 文档；适用范围见 evidence.md。
- **S5-field · 实现证据**：[原文件](sources/ion-settings/evidence-excerpts.json)，定位 `entries[id=field-states]`。字段的 hover 排除 focus、invalid、disabled；错误焦点使用 shadow-focus-danger。字符位置可复核，未验证 Claude 运行时最终像素。
- **S5-nav · 实现证据**：[原文件](sources/ion-settings/evidence-excerpts.json)，定位 `entries[id=settings-row-states]`。Claude 设置导航的选中与悬停。不能直接等同会话导航的全部行为。

## 输入框

设置页原生 input。直接加载生产 settings-theme.css；它目前是 shell.tsx 内联原生字段，没有独立 React 输入框组件。

复用方式：**原生控件 + 生产样式**。在普通字段上悬停、点击或用 Tab 聚焦。错误探针只添加 aria-invalid，用来观察现有 CSS 是否响应；它不代表产品已经接入字段级校验。

源码：[shell.tsx](../../../apps/dashboard/src/desktop/shell.tsx)、[settings-theme.css](../../../apps/dashboard/src/desktop/settings-theme.css)

| 状态 | CDS 依据 | LXE 当前实现 | 分类 |
| --- | --- | --- | --- |
| 默认 | S1、S5-field | 背景 --cds-field；主文字 --text；1px --border。 | 已适配 |
| 悬停 | S5-field | 未禁用、未 focus-visible 时边框变为 --border-strong；未排除错误状态。 | 部分适配 |
| 焦点／悬停＋焦点 | S1、S5-field | 透明边界、--cds-focus 蓝环；表面隔离环与尺寸为 LXE 配方。 | LXE 适配 |
| 禁用 | S1 | 仍使用整个输入框 opacity: .4；未采用独立的禁用文字和填充变量。 | 已知偏差 |
| 错误／错误＋焦点（探针） | S5-field | 仅设置 aria-invalid 时没有错误专用边界；焦点仍为普通蓝环。探针不是生产错误流程。 | 实现缺口 |

核对位置与验收：

- **field-default**：`.desktop-settings-theme .desktop-settings-content input`。读取默认背景、文字与边界；核对可编辑。
- **field-hover**：`.desktop-settings-theme :is(input, select, textarea):hover:not(:disabled):not(:focus-visible)`。真实鼠标移入；与默认、禁用、错误探针对照。
- **field-focus**：`.desktop-settings-theme :is(input, select, textarea):focus-visible`。Tab 聚焦后再移入鼠标，核对焦点环未被悬停覆盖。
- **field-disabled**：`.desktop-settings-theme :is(input, select, textarea):disabled`。核对 opacity、不可编辑、Tab 跳过及无悬停提亮。
- **field-invalid**：`.desktop-settings-theme input[aria-invalid=true]（当前没有专用规则）`。与正常字段默认／悬停／焦点值比较；如后续实现改变，检查会要求更新记录。

尚未查清：

- Claude 字段在所有表面上的最终计算样式未抓取。
- 生产设置字段尚未统一接入 aria-invalid 和错误说明关联。
- 占位符、禁用文字的实际合成对比度尚未专项审计。

## 导航行

会话侧边栏的 SessionsIndex。30px 会话行、10px 工作区间距与文字层级是 LXE 适配；标题用满行宽，尾部以 20px 渐隐代替省略号。悬停、键盘聚焦或菜单打开时，菜单覆盖在右侧，渐隐终点内收 36px，文字位置不变。分组及搜索列表使用靠右的 8px 滚动条轨道，与行背景间隔 2px；滑块仅在滚动或拖动轨道时显示，停止约 800ms 后隐藏，鼠标移入及单纯聚焦不触发，拖动中保持显示，轨道宽度不变。这些尺寸与交互是 LXE 适配，不是已确认的 CDS 原始规则。当前实现见下方生产源码。组件状态实测见 showcase/verification.json，不是所有导航组件的完整审计。

复用方式：**生产 SessionsIndex**。点击切换当前会话；悬停选中与未选中的行；用 Tab / Enter 导航。更多菜单沿用生产组件，动作只修改当前样本数据。

源码：[view.tsx](../../../apps/dashboard/src/features/sessions/view.tsx)、[sidebar-theme.css](../../../apps/dashboard/src/features/sessions/sidebar-theme.css)、[use-sidebar-scrollbar.ts](../../../apps/dashboard/src/features/sessions/use-sidebar-scrollbar.ts)、[styles.css](../../../apps/dashboard/src/styles.css)

| 状态 | CDS 依据 | LXE 当前实现 | 分类 |
| --- | --- | --- | --- |
| 默认／悬停 | S1、S5-nav | 导航面 --cds-surface-nav；悬停为背景 95% + 前景 5% 的不透明混色。会话标题 13px、400 字重，默认 secondary，悬停或键盘焦点为 ink。 | LXE 适配 |
| 选中／选中＋悬停 | S5-nav | 浅色背景 94% + 前景 6%，暗色背景 90% + 前景 10%；选中标题均为 400 字重。与设置导航暗色白 15% 不同，是会话行的局部选择。 | LXE 适配 |
| 键盘焦点／选中＋焦点 | S1 | 使用现有导航焦点规则与蓝色 --focus-ring。 | LXE 适配 |
| 禁用／错误行 | 无专用上游依据／本地接口 | 当前 SessionsIndex 没有整行 disabled 或 invalid 接口；运行结果状态图标是另一维度。 | 不适用 |

核对位置与验收：

- **navigation-default**：`.app-sidebar.conversation-chrome-theme / .session-index-item:hover`。读取表面、文字和行悬停背景；点击能切换选中。
- **navigation-selected**：`.app-sidebar.conversation-chrome-theme .session-index-item.active`。选中持续显示 aria-current=page；移入鼠标保持选中背景。
- **navigation-focus**：`.session-index-open:focus-visible`。真实 Tab 聚焦、Enter 选中，读取 outline；不把程序添加 class 当成焦点。
- **navigation-na**：`SessionsIndex props`。不伪造整行禁用／错误样本；会话状态图标不在本轮范围。

尚未查清：

- 已取得的直接导航证据来自 Claude 设置页，Claude 会话导航的专用状态规则未确认。
- 菜单、工作区标题、搜索结果与状态图标未纳入本轮完整状态矩阵。

## 工具调用条

UnifiedConversationRow 的 tool 分支，置于生产 conversation-feed 作用域；不额外套 CDS 主题以掩盖遗留配色。

复用方式：**生产 UnifiedConversationRow**。五种执行状态均可悬停、用 Tab 聚焦和点击展开。示例命令只作为文本展示，不会执行。

源码：[view.tsx](../../../apps/dashboard/src/features/sessions/view.tsx)、[styles.css](../../../apps/dashboard/src/styles.css)

| 状态 | CDS 依据 | LXE 当前实现 | 分类 |
| --- | --- | --- | --- |
| 默认 · 五种执行状态 | S1 | pending / running / success / error / unconfirmed 使用生产状态名称与图标；默认文字、状态色仍有旧主题变量。 | 部分适配 |
| 悬停 | S1 | 背景保持透明，普通名称及参数文字提亮；错误名称、状态图标保留原色。 | LXE 选择 |
| 键盘焦点 | S1 | 文字同悬停；outline 仍引用旧 --tool-border-strong，尚未统一为 CDS 蓝环。 | 已知偏差 |
| 展开／收起 | 无专用上游依据／本地接口 | 真实按钮切换 aria-expanded，展开参数和示例结果。 | LXE 行为 |
| 禁用 | 无专用上游依据／本地接口 | 这一生产分支没有 disabled prop；历史 CSS 有禁用保护，但不据此宣称存在业务禁用状态。 | 不适用 |

核对位置与验收：

- **tool-default**：`.tool-op.state-* / .tool-status-icon`。检查五种真实组件状态和图标标签；没有执行任何命令。
- **tool-hover**：`.conversation-feed .tool-op-summary:is(:hover, :focus-visible)`。两种主题逐一移入五种状态，比较文字、透明背景、状态色与尺寸。
- **tool-focus**：`.tool-op-summary:focus-visible`。Tab 聚焦，读取真实 outline；焦点可见不等于已经统一配色。
- **tool-expanded**：`UnifiedConversationRow / .tool-op-body`。点击、Enter 展开与收起；已展开状态再次悬停。
- **tool-na**：`UnifiedConversationRow tool 分支`。不通过改 DOM 属性伪造生产禁用支持。

尚未查清：

- 没有取得 Claude tool use 专用 hover、focus、展开状态的完整规范；通用 CDS 原则仅作参考。
- 默认态和状态图标仍混用旧变量，不能宣称工具调用条已完整迁移。

## 本轮实测的范围与限制

- 原规则、静态实现证据、LXE 实测分开记录；本地实测通过不会提高上游证据等级。
- 展示页使用示例数据；不连接真实会话、配置、账号或命令执行。
- 未进行完整对比度、读屏、触屏或所有平台审计。
- hover 与 focus 用真实浏览器交互触发；按下态可自然操作，但本轮没有独立的 pressed 视觉规范或验收断言。
- 输入框未抽成独立 React 组件：样本使用与设置页相同的原生 input 和生产 CSS，容器只调整排布，不复制颜色规则；完整设置保存流程不在本轮范围。
- 导航行与工具调用条直接导入生产 React 组件。上下文表面与主题作用域保留；样本外框、说明、检查器属于展示页。
- 展示页使用独立 iframe 隔离亮暗主题，避免把根节点主题选择器错误地套到局部容器。
- 检查包含输入框的错误＋焦点、导航的选中＋悬停／焦点、五类工具条状态的悬停／焦点／展开；禁用导航与禁用工具条标为不适用，不篡改 DOM 伪造接口。

## 待补证据清单

1. Claude 会话导航专用规则：选中叠加 hover、键盘焦点、菜单打开时的优先级。
2. Claude 工具调用条专用规则：五类执行状态、hover、focus 与展开状态的实际映射。
3. Claude 输入框运行时：错误＋焦点、禁用叠加其他状态、不同表面上的最终合成颜色。
4. LXE 后续改动候选：字段级错误接入、禁用语义变量、工具条遗留变量。它们在本任务仅记录，没有顺带修改产品外观。
