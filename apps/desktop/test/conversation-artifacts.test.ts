import { describe, expect, test } from "bun:test";
import { DashboardRpcError } from "@lxe/desktop-protocol";
import { openConversationArtifact } from "../src/main/conversation-artifacts";

describe("conversation artifact opening", () => {
  test("opens only the path resolved by the agent-owned transcript", async () => {
    const resolved: string[] = [];
    const opened: string[] = [];
    const result = await openConversationArtifact({
      resolveArtifact: async (sessionId, artifactId) => {
        resolved.push(`${sessionId}:${artifactId}`);
        return "/private/artifacts/report.xlsx";
      },
      openPath: async (path) => {
        opened.push(path);
        return "";
      },
    }, "session-1", "artifact-1");

    expect(resolved).toEqual(["session-1:artifact-1"]);
    expect(opened).toEqual(["/private/artifacts/report.xlsx"]);
    expect(result).toEqual({ opened: true, error: "" });
  });

  test("preserves the operating system error for a deleted file", async () => {
    const result = await openConversationArtifact({
      resolveArtifact: async () => "/private/artifacts/deleted.xlsx",
      openPath: async () => "The file does not exist.",
    }, "session-1", "artifact-1");
    expect(result).toEqual({ opened: false, error: "The file does not exist." });
  });

  test("rejects unknown and cross-session artifact ids before opening", async () => {
    let opened = false;
    const action = openConversationArtifact({
      resolveArtifact: async () => undefined,
      openPath: async () => {
        opened = true;
        return "";
      },
    }, "other-session", "artifact-1");
    await expect(action).rejects.toBeInstanceOf(DashboardRpcError);
    expect(opened).toBe(false);
  });
});
