import { describe, expect, test } from "bun:test";
import { DashboardRpcError } from "@lxe/desktop-protocol";
import {
  openConversationArtifact,
  openConversationAttachment,
  revealConversationArtifact,
} from "../src/main/conversation-artifacts";

describe("conversation artifact opening", () => {
  test("opens an input attachment only after agent-owned session resolution", async () => {
    const opened: string[] = [];
    const result = await openConversationAttachment({
      resolveAttachment: async (sessionId, attachmentId) =>
        sessionId === "session-1" && attachmentId === "attachment-1" ? "/private/input/orders.csv" : undefined,
      openPath: async (path) => { opened.push(path); return ""; },
    }, "session-1", "attachment-1");
    expect(result).toEqual({ opened: true, error: "" });
    expect(opened).toEqual(["/private/input/orders.csv"]);
    await expect(openConversationAttachment({
      resolveAttachment: async () => undefined,
      openPath: async () => { throw new Error("must not open"); },
    }, "other", "attachment-1")).rejects.toMatchObject({ code: "not_found" });
  });

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

  test("reveals only the path resolved by the agent-owned transcript", async () => {
    const revealed: string[] = [];
    const result = await revealConversationArtifact({
      resolveArtifact: async (sessionId, artifactId) =>
        sessionId === "session-1" && artifactId === "artifact-1" ? "/private/artifacts/report.xlsx" : undefined,
      assertExists: async () => {},
      revealPath: (path) => { revealed.push(path); },
    }, "session-1", "artifact-1");

    expect(result).toEqual({ revealed: true, error: "" });
    expect(revealed).toEqual(["/private/artifacts/report.xlsx"]);
  });

  test("reports the filesystem's own text when the file has moved away", async () => {
    let revealed = false;
    // showItemInFolder answers with nothing, so this existence check is the
    // only place a moved or deleted file can still be reported truthfully -
    // without it the app would open a folder and say the reveal succeeded.
    const result = await revealConversationArtifact({
      resolveArtifact: async () => "/private/artifacts/moved.xlsx",
      assertExists: async () => {
        throw new Error("ENOENT: no such file or directory, access '/private/artifacts/moved.xlsx'");
      },
      revealPath: () => { revealed = true; },
    }, "session-1", "artifact-1");

    expect(result.revealed).toBe(false);
    expect(result.error).toBe(
      "ENOENT: no such file or directory, access '/private/artifacts/moved.xlsx'");
    expect(revealed).toBe(false);
  });

  test("rejects unknown and cross-session artifact ids before revealing", async () => {
    let revealed = false;
    const action = revealConversationArtifact({
      resolveArtifact: async () => undefined,
      assertExists: async () => { throw new Error("must not check"); },
      revealPath: () => { revealed = true; },
    }, "other-session", "artifact-1");
    await expect(action).rejects.toBeInstanceOf(DashboardRpcError);
    expect(revealed).toBe(false);
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
