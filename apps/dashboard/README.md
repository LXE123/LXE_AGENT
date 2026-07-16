# LXE Agent Desktop Renderer

这里是 LXE Agent macOS/Windows 桌面应用的唯一 React Renderer。它使用 React、TypeScript 和 Vite 构建，不作为独立网站发布。

开发与构建统一使用根工作区固定的 Bun 1.3.14。

## 运行边界

- 生产环境由 Electron 通过 `app://lxe/` 加载 `dist/`。
- 开发环境由 `desktop:dev` 启动 Vite，再由 Electron 加载开发地址。
- 所有业务请求通过 `window.lxe.dashboard` preload bridge 进入 Electron Main 和内嵌 Gateway。
- 本工程不提供 HTTP API fallback、浏览器部署、独立预览服务或 Gateway 端口。

直接在普通浏览器打开页面会显示 preload bridge 不可用，这是预期行为。

## 本地开发

在仓库根目录安装固定依赖：

```bash
bun install --frozen-lockfile
```

启动完整桌面开发环境：

```bash
bun run desktop:dev
```

该命令会先构建 Electron Main/Preload，再启动 Vite 和 Electron。不要单独把 Vite 页面当作产品入口。

## 构建与验证

单独检查 Renderer：

```bash
bun run --cwd apps/dashboard typecheck
bun run dashboard:build
```

完整桌面构建：

```bash
bun run desktop:build
```

输出的 `apps/dashboard/dist/` 会由桌面资源打包流程收集。真实 API、会话、模型切换和配置管理都依赖 Electron preload bridge。
