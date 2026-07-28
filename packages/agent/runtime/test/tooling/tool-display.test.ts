import { describe, expect, test } from "bun:test";
import { buildToolDisplayStep } from "../../src/tooling/tool-display";

describe("tool display", () => {
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
