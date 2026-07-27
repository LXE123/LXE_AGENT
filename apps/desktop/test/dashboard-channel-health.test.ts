import { describe, expect, test } from "bun:test";
import { publicDashboardChannelHealth } from "../src/main/dashboard-channel-health";

describe("Dashboard channel health", () => {
  test("does not expose the internal desktop response adapter as a Feishu channel", () => {
    expect(publicDashboardChannelHealth({
      desktop: { ready: true },
      feishu: { ready: false, running: false },
    })).toEqual({ feishu: { ready: false, running: false } });
  });
});
