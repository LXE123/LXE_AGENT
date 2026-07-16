import { Component, type ErrorInfo, type ReactNode } from "react";

import { BrandMark } from "./shared/ui/brand-mark";

interface DashboardRootErrorBoundaryProps {
  children: ReactNode;
}

interface DashboardRootErrorBoundaryState {
  failed: boolean;
}

export function reloadDesktopRenderer(reload: () => void = () => window.location.reload()): void {
  reload();
}

export function RendererFailureView(): ReactNode {
  return (
    <main className="desktop-fatal desktop-window-frame" data-lxe-root-state="fatal" role="alert">
      <div aria-hidden className="desktop-window-drag-region" />
      <section className="desktop-fatal-card">
        <div className="desktop-fatal-mark"><BrandMark title="LXE Agent" /></div>
        <p className="desktop-eyebrow">LXE Agent Desktop</p>
        <h1>界面启动失败</h1>
        <p>应用没有完成界面初始化。请重新加载；如果问题持续出现，请查看终端或应用日志。</p>
        <button className="desktop-primary-button" onClick={() => reloadDesktopRenderer()} type="button">
          重新加载
        </button>
      </section>
    </main>
  );
}

export class DashboardRootErrorBoundary extends Component<
  DashboardRootErrorBoundaryProps,
  DashboardRootErrorBoundaryState
> {
  state: DashboardRootErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): DashboardRootErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("LXE Agent Renderer failed to start", error, info);
  }

  render(): ReactNode {
    if (this.state.failed) return <RendererFailureView />;
    return this.props.children;
  }
}
