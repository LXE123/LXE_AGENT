import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingProcessManager } from "../../src/tooling/coding/process-manager";
import { ProgressEnvelopeDecoder, progressEnvelope } from "../../src/tooling/coding/progress-envelope";
import { ExecShellAdapter } from "../../src/tooling/exec-shell";
import { removeTemporaryRoot } from "../temp-directory";
import { workspaceFor } from "../workspace";

const command = "demo export execute";
const progress = (stage: string, message: string, fields: Record<string, unknown> = {}): string => JSON.stringify({
  protocol_version: "1", type: "progress", command, stage, message, ...fields,
});

describe("generic business progress envelope", () => {
  test("decodes split CLI progress and ignores terminal output", () => {
    const decoder = new ProgressEnvelopeDecoder(command);
    const bytes = new TextEncoder().encode(`${progress("listed", "第2页读取3条", { page: 2 })}\n`);
    expect(decoder.push(bytes.subarray(0, 19))).toEqual([]);
    expect(decoder.push(bytes.subarray(19))).toEqual([{ stage: "listed", message: "第2页读取3条" }]);
    expect(decoder.push(new TextEncoder().encode(`${JSON.stringify({ type: "result", ok: true })}\n`))).toEqual([]);
  });

  test("rejects unsafe or unrelated records", () => {
    expect(progressEnvelope(progress("listed", "page 1", { token: "secret" }), command)).toBeUndefined();
    expect(progressEnvelope(progress("listed", "page 1", { page: -1 }), command)).toBeUndefined();
    expect(progressEnvelope(progress("toString", "token=secret"), command)).toBeUndefined();
    expect(progressEnvelope(progress("authenticated", "ready").replace(command, "other"), command)).toBeUndefined();
    const decoder = new ProgressEnvelopeDecoder(command);
    expect(decoder.push(new TextEncoder().encode(`${"x".repeat(3_000)}\n${progress("merged", "2 pages complete")}\n`)))
      .toEqual([{ stage: "merged", message: "2 pages complete" }]);
  });

  test("stdout pump publishes only progress belonging to the invoked business command", async () => {
    const root = mkdtempSync(join(tmpdir(), "business-progress-"));
    const manager = new CodingProcessManager({ maxOutputBytes: 64_000, tailBytes: 2_000, shell: new ExecShellAdapter() });
    const published: string[] = [];
    manager.onToolProgress = (event) => {
      expect(event).toMatchObject({ sessionId: "session-1", turnId: "turn-1", toolCallId: "tool-1", stage: "authenticated" });
      published.push(event.message);
    };
    try {
      const valid = progress("authenticated", "登录成功");
      const unsafe = progress("authenticated", "token=secret");
      const shellCommand = process.platform === "win32"
        ? `Write-Output '${valid}'; Write-Output '${unsafe}'`
        : `printf '%s\\n' '${valid}' '${unsafe}'`;
      const result = await manager.execute({
        command: shellCommand, cwd: root, sessionId: "session-1", responseRouteId: "route-1",
        workspace: workspaceFor(root), yieldMs: 5_000, signal: new AbortController().signal,
        toolCallId: "tool-1", turnId: "turn-1", progressCommand: command,
      });
      expect(result.status).toBe("completed");
      expect(published).toEqual(["登录成功"]);
    } finally {
      await manager.stop();
      await removeTemporaryRoot(root);
    }
  });
});
