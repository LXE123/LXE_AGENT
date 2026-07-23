import { describe, expect, test } from "bun:test";
import type { DesktopHealth } from "@lxe/desktop-protocol";

import {
  aggregateAgentState,
  aggregateRuntimeTone,
  cloudAggregateTone,
  cloudTone,
  summarizeChannelState,
} from "../../../src/features/runtime-status/model";

const health = (patch: Partial<DesktopHealth> = {}): DesktopHealth => ({
  gateway: "ready",
  agent_cli: "ready",
  lxeskill: "ready",
  message: "",
  version: "0.1.0",
  resource_root: "/resources",
  data_root: "/data",
  workspace_root: "/workspace",
  logging: {
    desktop: {
      local_file_enabled: true,
      file_path: "/data/var/logs/runtime/20260717/desktop.log",
      disabled_reason: "",
      last_error: "",
      console_level: "info",
      file_level: "info",
    },
  },
  ...patch,
});

describe("global runtime status model", () => {
  test("aggregates agent-cli and lxeskill by the most actionable state", () => {
    expect(aggregateAgentState(health())).toBe("ready");
    expect(aggregateAgentState(health({ lxeskill: "starting" }))).toBe("starting");
    expect(aggregateAgentState(health({ agent_cli: "stopped", lxeskill: "starting" }))).toBe("stopped");
    expect(aggregateAgentState(health({ agent_cli: "error", lxeskill: "stopped" }))).toBe("error");
  });

  test("summarizes channel health without treating an unconfigured channel as an error", () => {
    expect(summarizeChannelState({ items: {}, total: 0 })).toBe("unconfigured");
    expect(summarizeChannelState(undefined, true)).toBe("unavailable");
    expect(summarizeChannelState({
      items: { feishu: { ready: true, connection_state: "connected", last_error: "stale" } },
      total: 1,
    })).toBe("connected");
    expect(summarizeChannelState({
      items: { feishu: { ready: false, restart_in_progress: true, connection_state: "reconnecting" } },
      total: 1,
    })).toBe("connecting");
    expect(summarizeChannelState({
      items: { feishu: { ready: false, running: true, last_error: "offline" } },
      total: 1,
    })).toBe("error");
    expect(summarizeChannelState({
      items: { feishu: { running: false } },
      total: 1,
    })).toBe("disabled");
  });

  test("promotes the most actionable tone to the floating trigger", () => {
    expect(aggregateRuntimeTone(["healthy", "healthy"])).toBe("healthy");
    expect(aggregateRuntimeTone(["healthy", "neutral"])).toBe("neutral");
    expect(aggregateRuntimeTone(["healthy", "progress", "neutral"])).toBe("progress");
    expect(aggregateRuntimeTone(["progress", "warning", "healthy"])).toBe("warning");
  });

  test("maps configured cloud failures into the aggregate without penalizing optional states", () => {
    expect(cloudTone("connected")).toBe("healthy");
    expect(cloudTone("provisioning")).toBe("progress");
    expect(cloudTone("connecting")).toBe("progress");
    expect(cloudTone("offline")).toBe("warning");
    expect(cloudTone("error")).toBe("warning");
    expect(cloudAggregateTone("not_configured")).toBeUndefined();
    expect(cloudAggregateTone("unsupported")).toBeUndefined();
    expect(cloudAggregateTone("connected")).toBe("healthy");
  });
});
