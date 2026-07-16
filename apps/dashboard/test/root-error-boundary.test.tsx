import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";

import {
  DashboardRootErrorBoundary,
  reloadDesktopRenderer,
  RendererFailureView,
} from "../src/root-error-boundary";

describe("Dashboard root error fallback", () => {
  test("switches the root boundary into a branded fatal state", () => {
    expect(DashboardRootErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new DashboardRootErrorBoundary({ children: "Dashboard" });
    Object.assign(boundary, { state: { failed: true } });
    const rendered = boundary.render() as ReactElement;
    expect(isValidElement(rendered)).toBe(true);
    expect(rendered.type).toBe(RendererFailureView);

    const failure = RendererFailureView() as ReactElement<{
      "data-lxe-root-state": string;
      role: string;
    }>;
    expect(failure.props["data-lxe-root-state"]).toBe("fatal");
    expect(failure.props.role).toBe("alert");
    const visibleMarkup = JSON.stringify(failure);
    expect(visibleMarkup).toContain("界面启动失败");
    expect(visibleMarkup).not.toContain("stack");
  });

  test("delegates reload without exposing Renderer details", () => {
    let reloads = 0;
    reloadDesktopRenderer(() => { reloads += 1; });
    expect(reloads).toBe(1);
  });
});
