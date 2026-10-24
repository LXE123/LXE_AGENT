# CDS 色彩使用指南

CDS 是 **Claude Design System**，即 Claude 设计系统。颜色是其中一套独立定义、再由组件共同使用的规则：先定义颜色的语义和搭配，再由导航、输入框、按钮、卡片等组件决定在什么状态下引用它们。

例如，导航选中态和列表选中态可以共同引用 `fill-ghost-selected`。它们不需要各自发明一份“选中灰色”。因此，要复用的是“颜色 → 用途 → 状态”的关系。

本指南以已取得的 [CDS tokens — vanilla 原文](sources/cds-tokens-vanilla.original.md)为主。下文的 **原规则**、**实现证据**、**LXE 适配**和**未验证／有冲突**按[资料库说明](README.md#四种标记)区分。

## 1. 颜色分层：组件用语义，不直接猜色号

**原规则**：CDS 把 token 分为以下层次。这里的 token 就是具有明确用途的命名变量。

| 层 | 解决的问题 | 示例 |
| --- | --- | --- |
| 基础色板 | 某个固定的色值是什么 | `gray-500`、`blue-450` |
| 主题色阶 | 同一个明暗角色，在亮暗主题中如何翻转 | `neutral-*`、`alpha-*` |
| 表面层级 | 页面、面板、弹层如何区分 | `surface-0` 至 `surface-3` |
| 用途层 | 某个 UI 元素应承担什么视觉角色 | `text-secondary`、`fill-field`、`border` |
| 密度、动效 | 控件大小、间距和变化节奏 | `h-control`、`gap-*`、`dur-*` |

组件主要消费用途层，尺寸消费密度层。普通界面样式不应随手写一个固定灰色；应该表达它是“说明文字”还是“弱化元数据”。

Vanilla 文档使用 `--text-primary` 等无前缀变量；桌面 React 打包资源中可见 `--cds-text-primary`。**LXE 的 `--cds-ink` 等变量是我们自己的命名，不是官方 API 名称。**

出处：[Token rule](sources/cds-tokens-vanilla.original.md#token-rule)、[The layer model](sources/cds-tokens-vanilla.original.md#the-layer-model)。

## 2. 表面：让结构靠明度和留白显现

**原规则**：`surface-0` 是基础画布，`surface-1` 用于流内卡片，`surface-2` 用于面板，`surface-3` 用于弹出层。编号表达绝对明度：两种主题下都是从暗到亮；亮色的第 2、3 层可以同为白色。

| Token | 亮色映射 | 暗色映射 | 典型用途 |
| --- | --- | --- | --- |
| `surface-0` | `gray-20` → `#f9f9f7` | `gray-900` → `#0b0b0b` | 页面画布 |
| `surface-1` | `gray-10` → `#fcfcfb` | `gray-850` → `#151515` | 流内卡片 |
| `surface-2` | `gray-0` → `#ffffff` | `gray-830` → `#1a1a19` | 面板 |
| `surface-3` | `gray-0` → `#ffffff` | `gray-800` → `#20201f` | 弹出层 |

上表的映射来自原文，hex 由已提取的[基础色表](sources/cds-base-palette.csv)对应得出，不是对截图取色。应用可以选择自己的画布背景；不要把这些典型用途理解为每个页面必须套四层容器。

**原规则**：同时最多两个浮动层级；需要第三层时考虑 Dialog。流内平面卡片不算浮动层。弹层中的焦点环等“挖空”效果应混合到当前表面，而不是底下的整页背景。

**LXE 适配**：设置页用浅灰导航与白色内容面；暗色用 `#151515` 导航和 `#1a1a19` 内容面。弹出层暗色改为 `#232322`，不是照搬原文的 `#20201f`。

出处：[Elevation rule](sources/cds-tokens-vanilla.original.md#elevation-rule)、[3. Elevation](sources/cds-tokens-vanilla.original.md#3-elevation)。

## 3. 文字：解释文字不应弱到看不清

**原规则**：

| 角色 | 用途 | 不应混用的场景 |
| --- | --- | --- |
| `text-primary` | 正文、关键标签、主要内容 | 不用彩色字替代所有重点 |
| `text-secondary` | 说明、补充解释 | 不应全部降到 muted |
| `text-muted` | 占位符、图注、元数据 | 不作为大段重要说明的默认色 |
| `text-disabled` | 禁用标签 | 不等同普通说明文字 |

原文明确禁止用文字 opacity 代替语义色：透明度会和底色相乘，换一个表面就可能变得更淡。浅边框使用 alpha 与“文字直接降透明度”是两件不同的事。

**LXE 适配**：`--text`、`--text-soft`、`--muted-light` 分别映射主文字、说明、元数据。普通说明遵循这层次；设置页部分禁用输入仍使用整个控件 `opacity: .4`，是现有偏差，不能宣称逐条完全遵守 CDS。

出处：[Muted text rule](sources/cds-tokens-vanilla.original.md#muted-text-rule)、[Purpose tokens](sources/cds-tokens-vanilla.original.md#purpose-tokens)。

## 4. 彩色：承担意义，少用作装饰

**原规则**：

| 语义角色 | 对应色相 | 用意 |
| --- | --- | --- |
| `accent` | blue | 强调、用户主操作 |
| `brand` | clay | Claude 发起的动作，如发送、生成和品牌标志 |
| `danger` | red | 危险、错误 |
| `success` | green | 成功 |
| `warning` | yellow | 警告 |
| `pro` | purple | Pro 角色 |

每个视图最多一个 accent 实心主按钮；同级按钮用 secondary 或 ghost。Clay 有专门语义，不应把所有普通按钮都涂成陶土色。

注意：原文另有 `fill-primary = neutral-900` 的用途变量。**“primary 按钮变体”“fill-primary 变量”和“accent 蓝色”不能只看名字就当作同一件事。**本资料没有给所有组件变体做完整运行时映射；LXE 将自己的主操作明确映射成蓝色，是适配选择。

**LXE 适配**：设置页底部保存按钮承担主操作；局部凭证按钮降低为次级。MCP 正常／错误状态用小范围语义色；模型品牌 Logo 保留，背景不再铺品牌色或装饰渐变。没有把 Claude 的 clay 品牌动作体系完整移植进 LXE。

出处：[Accent rule](sources/cds-tokens-vanilla.original.md#accent-rule)、[Clay is Claude's color](sources/cds-tokens-vanilla.original.md#clay-is-claudes-color)、[Roles](sources/cds-tokens-vanilla.original.md#roles)。

## 5. 浅底与实心填充：前景色需要成对使用

**原规则**：

| 情况 | 背景 | 前景 | 例子 |
| --- | --- | --- | --- |
| 浅色状态面 | `bg-{role}` | `text-{role}` | 错误提示、Banner、Toast |
| 实心操作面 | `fill-{role}` | `on-{role}` | 按钮、开关、勾选控件 |
| 彩色徽标 tint | `bg-tint-{hue}` | `text-tint-{hue}` | Badge |

“成功绿”并不是一个色号包办所有地方：浅绿提示框上的深绿字，与实心绿按钮上的前景色用途不同。不能把 `text-danger` 直接放在 `fill-danger` 上就认为搭配正确。

原文的 Badge tint 在亮色用 35% alpha、暗色用 75%，并按 `surface-1` 反解颜色以保留底层选中效果。若改变表面，需要一起处理 tint 和 opaque token。这是一套特定实现机制，**LXE 当前没有复制这套完整计算**。

出处：[Background vs. fill](sources/cds-tokens-vanilla.original.md#background-vs-fill)、[Palette tints](sources/cds-tokens-vanilla.original.md#palette-tints)。

## 6. 边框和状态：轻边界，明确反馈

**原规则**：默认边框用 `alpha-2`，强调边界用 `alpha-3`。亮色通常是深色的透明叠加，暗色翻转为浅色透明叠加，而不是每处硬编码实心灰。

| 状态或控件 | CDS 原文规则 | LXE 当前适配 |
| --- | --- | --- |
| 输入框静止背景 | 亮色白 50%；暗色 `alpha-1` | 同类策略 |
| 输入框静止边界 | `fill-field-ring = border` | `--border`，1px |
| Ghost 悬停 | 亮色 `alpha-1`；暗色白 7.5% | 两种主题均对应前景色 5% |
| Ghost 选中 | 亮色 `alpha-2`；暗色白 15% | 亮色 10%；暗色 15% |
| 键盘焦点 | `focus-shadow`，原文给出 accent 环与柔光 | 输入框为 1px 表面色隔离 + 3px 蓝环；按钮等为 2px outline |
| 禁用 | 专用 text/fill token；确需禁用时提供原因 | 保留业务禁用逻辑，部分禁用样式仍有差异 |

焦点和悬停不是同一个状态。键盘使用者需要明确焦点；选中状态要持续表达“当前位置”，不能只在鼠标移入时出现。

出处：[Purpose tokens](sources/cds-tokens-vanilla.original.md#purpose-tokens)；桌面组件状态的[可定位代码片段](sources/ion-settings/evidence-excerpts.json)。

## 7. 克制也属于规范，但具体布局不全是规范

**原规则**：默认选更安静、更轻的方案；次级按钮是默认；密集列表优先带边界的行，减少圆角卡片堆叠；不要在高密度工具面板到处使用强主按钮。

**LXE 适配**：设置页的 228px 导航、说明在左控件在右、固定保存栏；能力页的两列目录、下划线标签、1160px 内容宽度、模型平面卡片，都是我们结合现有业务和参考界面做的设计。它们体现了克制原则，但这些像素值和布局不是 CDS 给所有页面规定的标准。

出处：[Restraint rule](sources/cds-tokens-vanilla.original.md#restraint-rule)、[Restraint over options](sources/cds-tokens-vanilla.original.md#restraint-over-options)。

## 8. 图表、图示和代码差异有自己的用途规则

CDS 并非只有一张通用调色板。此次资料还包括图示、图表、交互表单等生成指导；应按场景选用。

| 材料 | 规则范围 | 使用边界 |
| --- | --- | --- |
| [图示 9 × 7 色板](sources/embedded-text-4.original.md) | 图示色板 | 不等于完整 9 色相基础色阶 |
| [数据可视化指导](sources/embedded-text-8.original.md) | 分类、连续、发散、状态、图表文字和网格 | 图表颜色不能直接变成普通设置页按钮色 |
| [CDS 的 git 角色](sources/cds-tokens-vanilla.original.md#git--roles) | added、removed、modified、merged 等 | Diff 语义，不等于完整语法高亮主题 |
| [Artifact 模板](sources/artifact-explainer-style.original.txt) | 特定解释页模板 | 不证明桌面设置页采用该模板 |

**原规则，限数据可视化材料**：分类色按 Cove 固定顺序使用，超过 8 类合并 Other 或拆图；连续量用单色阶，发散用两色加中性中点；文字用文字角色，不把数值、坐标、图例文字全染成系列色；状态颜色与图标、标签一起表达意义。

**未验证／有冲突**：图表材料把暗色 `surface-1` 示例写成 `#1a1a19`，而 CDS token 文档映射得到 `#151515`。不要把二者静默合并成一个“官方唯一正确值”。设置页上代码预览的语法高亮配色也不在本资料的完整验证范围内。

## 9. 使用这份收藏做下一页

以下是 **LXE 工作建议**，不是逐字抄自 CDS 的强制流程：

1. 先写出页面的信息层级和最主要的操作，再选布局。
2. 给背景、文字、边界、字段和状态分配用途变量，不先挑一堆好看的 hex。
3. 使用[现有生产主题](../../../apps/dashboard/src/shared/cds-theme.css)；已有类和继承关系要一起检查，尤其是移到 portal 的弹层。
4. 对照[实现与适配说明](lxe-adaptation.md)，在实际页面检查是否重复嵌套卡片、过多彩色按钮、说明过淡。
5. 实际查看亮暗主题和交互状态，记录验证范围与结果。没有检查过的行为标为未验证。

阅读数值前，先看[来源边界](evidence.md)和[适配差异](lxe-adaptation.md)。本指南没有宣称取得了 Claude 全产品、全组件、全状态的完整设计标准文件。
