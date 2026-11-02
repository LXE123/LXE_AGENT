# 主导航图标与动效

2026-11-02 起，主导航并入统一侧栏，顺序为：新建任务、技能与连接、工作台、定时任务、工作概览、统计。新建任务调用原有新建会话动作，其余入口保持对应路由。布局及后续组件化计划见 [Agent 桌面界面改版](../agent-ui-refresh.md)。

六个图标在 [navigation-icons.tsx](../../../apps/dashboard/src/shared/navigation-icons.tsx) 中统一绘制，使用 24 单位画布、19px 导航显示尺寸（SVG 自身默认尺寸为 22px）、1.65 单位圆角笔画。工作台只保留面板分隔，能力使用三块组合模块，定时任务只保留圆环与指针，去掉叠层、装饰点与内部填色。它们属于 LXE 定制图形，不是 CDS 提供的图标资源。

颜色沿用导航的背景、文字、选中和焦点变量，保持当前亮暗主题。普通窗口下，展开后的按钮宽度随侧栏变化、高 40px；收起后为 40 × 40px，短窗口高 34px，不跟随图形缩放；读屏名称来自按钮，SVG 为装饰，不单独获取焦点。

动效仅回应交互：悬停或键盘聚焦时，回复线和面板分隔轻移、时针轻拨、能力模块轻转或活动柱线轻缩，260–320ms 后停止。进入选中态时图形有 180ms 的轻微缩放。没有定时器、循环动画或新增动画依赖；时钟动效不代表后台任务正在执行。系统启用 `prefers-reduced-motion: reduce` 时关闭图标动画与导航过渡，选中和焦点反馈仍然保留。

## 验证

从仓库根运行：

```sh
bun test apps/dashboard/test/behavior/renderer.test.ts --test-name-pattern 'navigation-rail|dashboard-pages|sidebar|windows-titlebar'
bun run --cwd apps/dashboard typecheck
bun run dashboard:build
```

可选设置 `LXE_NAVIGATION_CAPTURE_DIR` 为输出目录，导航测试会额外保存浅色、深色任务页和 390px 窄屏截图。2026-10-23 的悬停、焦点截图和动画记录保留为历史证据。未设置时不生成文件。

历史验证：2026-10-23，macOS 与 Windows 实机均通过导航专项的 8 个场景：亮暗主题下的顺序与可访问名称、有限动画与选中状态、键盘与窄屏、减少动态效果。macOS 同时通过 Dashboard 页面、侧栏回归（合计 3 个 Renderer 测试），Windows 加上标题栏（合计 4 个）。两平台 Dashboard 类型检查和生产构建通过。

截图与记录：[macOS 亮色](showcase/navigation-rail/macos/page-light.png)、[暗色](showcase/navigation-rail/macos/page-dark.png)、[动画记录](showcase/navigation-rail/macos/motion.json)；[Windows 亮色](showcase/navigation-rail/windows/page-light.png)、[暗色](showcase/navigation-rail/windows/page-dark.png)、[动画记录](showcase/navigation-rail/windows/motion.json)。同目录保存焦点、悬停和窄屏截图。

测试在完整生产桌面布局中操作真实 Electron 控件，接口使用 fixture；不是安装包验收，也不覆盖读屏软件、触屏或真实业务任务。本次没有修改调度和存储逻辑。

2026-11-02 首版统一侧栏已在 macOS 的完整 renderer 回归中通过，当前 8 个导航场景覆盖任务页、草稿与发送、收起、窄窗口、键盘、预览与减少动态效果。历史 Windows 实机结果不代表新版布局已经做过 Windows 实机验证。
