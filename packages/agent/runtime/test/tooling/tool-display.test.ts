import { describe, expect, test } from "bun:test";
import { buildToolDisplayStep } from "../../src/tooling/tool-display";

describe("tool display", () => {
  test("keeps complete exec commands without redaction, path shortening, or truncation", () => {
    const command = [
      "TOKEN=raw-secret run /private/workspace/script.sh --password visible-password",
      `--payload ${"x".repeat(300)}`,
    ].join("\n");

    for (const status of ["running", "success", "error"] as const) {
      const step = buildToolDisplayStep(`tool-exec-${status}`, "exec", { command }, status, 1);
      expect(step.detail).toBe(command);
      expect(step.detail.length).toBeGreaterThan(240);
    }
  });

  test("summarizes batched send_files paths", () => {
    const step = buildToolDisplayStep(
      "tool-1",
      "send_files",
      { paths: ["artifacts/first.xlsx", "artifacts/second.pdf"] },
      "running",
      0,
    );

    expect(step.title).toBe("Send files");
    expect(step.detail).toBe("artifacts/first.xlsx artifacts/second.pdf");
  });

  test("shortens every batched absolute path outside the desktop display", () => {
    const step = buildToolDisplayStep(
      "tool-1",
      "send_files",
      { paths: ["/private/artifacts/first.xlsx", "/private/artifacts/second.pdf"] },
      "running",
      0,
    );

    expect(step.detail).toBe(".../first.xlsx .../second.pdf");
  });

  test("keeps the legacy send_file title for historical transcripts", () => {
    const step = buildToolDisplayStep(
      "tool-1",
      "send_file",
      { path: "artifacts/legacy.xlsx" },
      "success",
      1,
    );

    expect(step.title).toBe("Send file");
    expect(step.detail).toBe("artifacts/legacy.xlsx");
  });
});
