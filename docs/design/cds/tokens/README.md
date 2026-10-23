# 色彩变量与使用方式

这里保存两类数据：CDS 证据中的原始／派生变量，以及 **LXE 在提交 7e2bef2d 时采用的适配变量快照**。不要把它们混成同一份官方主题，或误认为历史快照覆盖了后续所有组件的局部样式。当前实现见[适配总表](../current-adaptation.md)与生产源码。

## 文件入口

| 文件 | 性质与用途 |
| --- | --- |
| [CDS 基础色表](../sources/cds-base-palette.csv) | 从原资源提取的 315 个基础色声明；它不是组件直接使用的完整用途层 |
| [桌面声明 JSON](../sources/desktop-cds-declarations.json) / [TSV](../sources/desktop-cds-declarations.tsv) | 原样保留的静态解析结果，含选择器、偏移与内部变量 |
| [LXE CSS 快照](lxe-theme.snapshot.css) | 与实现提交 7e2bef2d 中共享主题逐字相同，可查亮暗覆盖和别名 |
| [LXE 变量 JSON](lxe-theme.tokens.json) | 从本快照派生的声明及别名解析结果，方便检索或转换 |
| [当前生产源码](../../../../apps/dashboard/src/shared/cds-theme.css) | 后续开发应引用和维护的位置 |

## LXE 的常用用途

| 用途 | LXE 变量 | 使用说明 |
| --- | --- | --- |
| 导航／低层表面 | `--cds-surface-nav` | 与内容面区分，不用层层套卡片 |
| 内容面／弹出层 | `--cds-surface-panel` / `--cds-surface-popover` | 按当前容器选择 |
| 主文字 | `--text` / `--cds-ink` | 标题、标签、正文 |
| 说明文字 | `--text-soft` / `--cds-secondary` | 必须读懂的解释 |
| 元数据／占位符 | `--muted-light` / `--cds-muted` | 不替代普通说明文字 |
| 普通／强调边框 | `--border` / `--border-strong` | 中性透明度色 |
| 行悬停／选中 | `--row-hover` / `--cds-selected` | 持续选中和短暂悬停分别处理 |
| 输入框 | `--cds-field` | 配合边界、焦点和错误状态 |
| 主操作 | `--cds-primary` + `--cds-primary-ink` | LXE 为蓝色方案，不等于原文 `fill-primary` |
| 错误提示 | `--danger-soft` + `--danger` + `--danger-border` | 浅底、文字、边界成组 |
| 错误操作 | `--cds-danger-action` / `--cds-danger-hover` | 与错误说明文字色分开 |
| 焦点 | `--cds-focus` | 字段的 box-shadow；按钮类另有 outline |

## 最小使用示例

先导入生产主题，并把容器放进已支持的作用域。这个例子只示范变量引用，不提供完整表单交互；别在任意不相关页面套这些类来绕过自己的主题设计。

```html
<div class="capabilities-theme">
  <div class="connection-note">连接状态的说明文字</div>
</div>
```

```css
.connection-note {
  background: var(--cds-surface-panel);
  color: var(--text-soft);
  border-bottom: 1px solid var(--border);
}
```

亮暗主题由应用已有的 `:root[data-theme="dark"]` 切换，组件使用相同变量。字体、布局、输入错误及无障碍行为还需要页面自己的实现。弹层脱离容器时要检查主题继承。

## 完整 LXE 变量表

下表由归档 CSS 自动整理。显示的是在该文件内递归展开别名后的值，**不是浏览器实际合成像素**；没有计算 alpha 与底色的混合，也没有包含其他文件的覆盖。原声明、暗色是否继承亮色表达式，见变量 JSON。

<!-- generated-token-table -->

共 58 个变量。

| 变量 | 亮色解析值 | 暗色解析值 |
| --- | --- | --- |
| `--cds-surface-nav` | `#fcfcfb` | `#151515` |
| `--cds-surface-panel` | `#ffffff` | `#1a1a19` |
| `--cds-surface-popover` | `#ffffff` | `#232322` |
| `--cds-ink` | `#0b0b0b` | `#f5f4ed` |
| `--cds-secondary` | `#52514e` | `#bfbdb5` |
| `--cds-muted` | `#898781` | `#9c9a92` |
| `--cds-alpha-1` | `rgb(11 11 11 / 5%)` | `rgb(255 255 255 / 5%)` |
| `--cds-alpha-2` | `rgb(11 11 11 / 10%)` | `rgb(255 255 255 / 10%)` |
| `--cds-alpha-3` | `rgb(11 11 11 / 20%)` | `rgb(255 255 255 / 20%)` |
| `--cds-field` | `rgb(255 255 255 / 50%)` | `rgb(255 255 255 / 5%)` |
| `--cds-selected` | `rgb(11 11 11 / 10%)` | `rgb(255 255 255 / 15%)` |
| `--cds-thumb` | `#ffffff` | `rgb(255 255 255 / 10%)` |
| `--cds-accent` | `#184f95` | `#6da7ec` |
| `--cds-accent-hover` | `#123e77` | `#92bff2` |
| `--cds-accent-tint` | `rgb(24 79 149 / 12%)` | `rgb(109 167 236 / 14%)` |
| `--cds-primary` | `#184f95` | `#6da7ec` |
| `--cds-primary-hover` | `#123e77` | `#92bff2` |
| `--cds-primary-ink` | `#ffffff` | `#0b0b0b` |
| `--cds-danger-action` | `#b42318` | `#b42318` |
| `--cds-danger-hover` | `#912018` | `#912018` |
| `--cds-focus` | `0 0 0 1px #ffffff, 0 0 0 3px #184f95` | `0 0 0 1px #1a1a19, 0 0 0 3px #6da7ec` |
| `--bg` | `#fcfcfb` | `#151515` |
| `--bg-soft` | `#ffffff` | `#1a1a19` |
| `--surface` | `#ffffff` | `#1a1a19` |
| `--surface-muted` | `rgb(11 11 11 / 5%)` | `rgb(255 255 255 / 5%)` |
| `--surface-subtle` | `#fcfcfb` | `#151515` |
| `--row-hover` | `rgb(11 11 11 / 5%)` | `rgb(255 255 255 / 5%)` |
| `--border` | `rgb(11 11 11 / 10%)` | `rgb(255 255 255 / 10%)` |
| `--border-strong` | `rgb(11 11 11 / 20%)` | `rgb(255 255 255 / 20%)` |
| `--text` | `#0b0b0b` | `#f5f4ed` |
| `--text-strong` | `#0b0b0b` | `#f5f4ed` |
| `--text-soft` | `#52514e` | `#bfbdb5` |
| `--muted` | `#52514e` | `#bfbdb5` |
| `--muted-light` | `#898781` | `#9c9a92` |
| `--accent` | `#184f95` | `#6da7ec` |
| `--accent-strong` | `#184f95` | `#6da7ec` |
| `--accent-soft` | `rgb(24 79 149 / 12%)` | `rgb(109 167 236 / 14%)` |
| `--accent-muted` | `rgb(11 11 11 / 20%)` | `rgb(255 255 255 / 20%)` |
| `--success` | `#287342` | `#8dca8d` |
| `--success-soft` | `#eef7f0` | `#253429` |
| `--success-border` | `#c9e2d0` | `#3e5844` |
| `--rate-good` | `#287342` | `#8dca8d` |
| `--rate-good-soft` | `#eef7f0` | `#253429` |
| `--danger` | `#b42318` | `#f28e85` |
| `--danger-soft` | `#fef3f2` | `#3d2827` |
| `--danger-border` | `#fecdca` | `#693b38` |
| `--warning` | `#805c13` | `#dec77f` |
| `--warning-soft` | `#fbf5df` | `#363022` |
| `--warning-border` | `#e9d9a4` | `#685632` |
| `--info` | `#184f95` | `#6da7ec` |
| `--info-soft` | `rgb(24 79 149 / 12%)` | `rgb(109 167 236 / 14%)` |
| `--focus-ring` | `rgb(24 79 149 / 12%)` | `rgb(109 167 236 / 14%)` |
| `--scrim` | `rgb(0 0 0 / 40%)` | `rgb(0 0 0 / 50%)` |
| `--shadow-soft` | `rgb(0 0 0 / 5%)` | `rgb(0 0 0 / 20%)` |
| `--shadow-medium` | `rgb(0 0 0 / 10%)` | `rgb(0 0 0 / 28%)` |
| `--shadow-strong` | `rgb(0 0 0 / 18%)` | `rgb(0 0 0 / 42%)` |
| `--shadow-card` | `0 1px 2px rgb(0 0 0 / 5%)` | `0 1px 2px rgb(0 0 0 / 20%)` |
| `--scrollbar-thumb` | `rgb(11 11 11 / 20%)` | `rgb(255 255 255 / 20%)` |

原规则与以上适配值的差异，见 [LXE 适配说明](../lxe-adaptation.md)。
