import { describe, expect, test } from "bun:test";
import { desktopLxeSkillState } from "../src/main/lxeskill-health";

describe("desktop lxeskill health", () => {
  test("shows the cached runtime probe instead of assuming files are usable", () => {
    expect(desktopLxeSkillState(undefined)).toBe("stopped");
    expect(desktopLxeSkillState({ state: "starting", pid: 1, message: "" })).toBe("starting");
    expect(desktopLxeSkillState({
      state: "error",
      pid: 0,
      message: "agent-cli exited",
      lxeskillAvailable: true,
    })).toBe("error");
    expect(desktopLxeSkillState({
      state: "ready",
      pid: 1,
      message: "",
      lxeskillAvailable: true,
    })).toBe("ready");
    expect(desktopLxeSkillState({
      state: "ready",
      pid: 1,
      message: "",
      lxeskillAvailable: false,
      lxeskillMessage: "No module named lxeskill",
    })).toBe("error");
  });
});
