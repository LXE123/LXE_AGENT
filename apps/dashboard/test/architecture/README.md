# Dashboard 测试边界

这里现在只检查模块依赖。`module-graph.mjs` 用仓库锁定的 TypeScript 解析器读取真实导入关系，
允许改名、格式化和类型连接；禁止绕过请求层、页面直接持有流程状态，以及反向依赖 App。
测试也覆盖别名、命名空间、重新导出、字面量动态导入、require 和空扫描失败。
它不是全程序数据流分析，不负责识别任意运行时计算的模块名或包装函数的行为。

页面行为由 `../behavior/renderer.test.ts` 在真实 Chromium 中验证。只替换桌面桥接和服务端响应，
不复制页面、hooks、缓存操作、流式处理或编辑器算法。断言优先检查可见结果、请求参数、焦点、
资源加载和元素的相对位置；不用 CSS 源码、函数名或某种 JSX 写法充当行为保障。

## 原有 14 个文件的去向

| 原测试 | 现在的保障 |
| --- | --- |
| markdown-headings、markdown-blockquote | `behavior/markdown.cjs`：两个真实消费页面的标题层级、引用嵌套和长内容完整性，包含窄窗口 |
| app-branding | `shared/application-assets.test.ts` 解析 favicon 文档与 PNG；`shared/brand-mark.test.tsx` 渲染语义；`dashboard-pages` 验证侧栏、引导、故障页面解码同一图片及版本来源 |
| provider-branding | `shared/provider-brand-mark.test.tsx` 的别名和回退；`features/models` 的真实能力投影；`dashboard-pages` 的本地图片解码、只读展示、精确可访问数值和减少动态效果 |
| macos-titlebar-layout、windows-titlebar-layout、window-drag-regions | `sidebar`、`windows-titlebar`：展开/折叠、窄窗、避让、实际 computed app-region、悬停与对比度；`windows-menu`：真实窗口焦点、全选、菜单键盘、设置和更新入口 |
| home-cockpit、information-architecture | `dashboard-pages`：首页数量限制、五个主入口、四个能力页、历史恢复、查询启用、MCP 工具/服务归属、状态弹层及工作台的不透明句柄和监听清理；`readiness`：就绪恢复 |
| settings-navigation | `dashboard-pages`：设置菜单、真实滚动、错误与版本、云端事件和固定入口权限；`desktop/settings-model`、`device-context-panel`：权限状态、独立草稿和实际错误 |
| local-model-auth | `dashboard-pages`：真实凭据提交、禁用、错误保留和重试；`desktop/local-model-environment`：执行环境过滤、解析发布模板。凭据存储、preload 与延迟加载继续由 Desktop/Gateway/Runtime 的原有行为测试负责 |
| frontend-polish | 侧栏和设置同上；`workspaces`：分组、独立分页、搜索、改名和偏好；`composer`/`permissions`：真实输入、权限菜单；保留已有功能测试，不复制一份 |
| conversation-interface | `conversation-content`：复制、高亮、宽表格、文件句柄、失败、过程时间、模型/思考菜单；`conversation-window` 复用原来的手工 fixture，自动验证节点身份、滚动分页、阅读锚点和过期响应；`app-actions`、`conversation-events`、`session-workspace` 加现有 display-controller/presentation/process/live-stream 单元测试覆盖缓存、草稿、订阅与顺序 |
| module-boundaries | 本目录的语法树依赖检查 |

有意移除的检查：精确 padding/bottom/圆角/颜色/字号、具体内部函数或变量名、JSX 顺序、
单文件行数和已无消费元素的 CSS 选择器。它们不是独立产品契约；改掉这些实现细节不应要求同步改测试。
字体可读性、内容完整性、控件避让、权限和交互等可观察要求仍有验证。

标题栏分成两个进程：悬停布局使用离屏窗口避免真实鼠标干扰；菜单焦点使用可聚焦窗口，
全选通过 Chromium 键盘输入同步 Lexical 状态。直接创建 DOM Range 无法代表编辑器的真实选区。
这些测试验证 Renderer 和桥接调用，不代替操作系统原生标题栏按钮、系统菜单或窗口拖动的验收。
