import { describe, expect, test } from "bun:test";
import { buildToolDisplayStep } from "../../src/tooling/tool-display";

describe("tool display", () => {
  test("desktop previews arguments at start and finish without changing the compact summary or other channels", () => {
    const code = 'const a = 2;\nreturn a;';
    for (const status of ["running", "success", "error"] as const) {
      const show = (name: string, input: Record<string, string>) =>
        buildToolDisplayStep("call-1", name, input, status, 0, { showInput: true });
      expect(show("codemode", { code })).toMatchObject({ detail: "", input_block: { language: "text", content: code } });
      const write = show("write", { file_path: "x", content: "one\ntwo" });
      expect(write.detail).toBe("x");
      expect(JSON.parse(write.input_block!.content)).toEqual({ file_path: "x", content: "one\ntwo" });
      expect(JSON.parse(show("wait", { exec_id: "exec_123" }).input_block!.content)).toEqual({ exec_id: "exec_123" });
      expect(buildToolDisplayStep("call-1", "codemode", { code }, status, 0)).not.toHaveProperty("input_block");
    }
    const args = { query: { selected: [1, 2], api_token: "fixture-secret" }, picture: {type:"image",data:"fixture-bytes"} };
    const preview = buildToolDisplayStep("call", "mcp__inventory__list", args, "running", 0, { showInput: true }).input_block!;
    expect(JSON.parse(preview.content).query).toEqual({ selected: [1, 2], api_token: "[redacted]" });
    expect(preview.content).not.toContain("fixture-bytes");
    const large = buildToolDisplayStep("call", "codemode", {code:"x".repeat(50_000)}, "running", 0, {showInput:true});
    expect(large.input_block!.content.length).toBeLessThan(50_000);
    expect(large.input_block!.content).toEndWith("[input truncated]");
  });
  test("preserves paths and escaped newlines in plain and JSON tool content", () => {
    const text = "output:\n缓存目录不存在\nC:\\Users\\Alice\\my reports\\report.txt\n/private/workspace/report.txt\nT:\\new\\test.txt";
    const structured = [{ type: "text", text }];
    for (const status of ["success", "error"] as const) {
      for (const content of [text, structured, JSON.stringify(structured)]) {
        const step = buildToolDisplayStep("call-1", "exec", {}, status, 1, { content, showResultDetails: true });
        const block = (status === "success" ? step.result_block : step.error_block)!;
        if (content === text) expect(block).toEqual({ language: "text", content: text });
        else {
          expect(block.language).toBe("json");
          expect(JSON.parse(block.content)).toEqual(structured);
        }
      }
    }
  });

  test("uses the same content for success and failure while keeping detail controls", () => {
    const content = [{ type: "text", text: "command output: 缓存目录不存在" }];
    for (const status of ["running", "success", "error"] as const) {
      for (const showResultDetails of [false, true]) {
        const step = buildToolDisplayStep("call-1", "exec", { command: "fixture" }, status, 1,
          { content, showResultDetails });
        if (status === "success" && showResultDetails) {
          expect(JSON.parse(step.result_block!.content)).toEqual(content);
        } else expect(step.result_block).toBeUndefined();
        if (status === "error") {
          expect(JSON.parse(step.error_block!.content)).toEqual(content);
        } else expect(step.error_block).toBeUndefined();
      }
    }
  });

  test("preserves exception text and does not invent content for empty results", () => {
    const failure = "ENOENT: fixture file missing\nsecond line";
    expect(buildToolDisplayStep("call-1", "exec", {}, "error", 1, { content: failure }).error_block)
      .toEqual({ language: "text", content: failure });
    for (const content of [undefined, null, "", " \n\t", []]) {
      for (const status of ["success", "error"] as const) {
        const step = buildToolDisplayStep("call-1", "exec", {}, status, 1, { content, showResultDetails: true });
        expect(step.result_block).toBeUndefined();
        expect(step.error_block).toBeUndefined();
      }
    }
  });

  test("sanitizes and bounds shared content using the existing status-specific limits", () => {
    const path = "/private/workspace/output.txt";
    const content = `failed at ${path} token=output-secret\n${"x".repeat(5_000)}`;
    for (const status of ["success", "error"] as const) {
      const step = buildToolDisplayStep("call-1", "exec", {}, status, 1,
        { content, showResultDetails: true });
      const block = (status === "success" ? step.result_block : step.error_block)!;
      expect(block.content).toContain(path);
      expect(block.content).not.toContain("output-secret");
      expect(block.content).toContain("[redacted]\n");
      expect(block.content.length).toBe(status === "success" ? 4_000 : 2_000);
      expect(block.content.endsWith("...")).toBe(true);
    }
  });

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

  test("preserves every batched absolute path", () => {
    const step = buildToolDisplayStep(
      "tool-1",
      "send_files",
      { paths: ["/private/artifacts/first.xlsx", "/private/artifacts/second.pdf"] },
      "running",
      0,
    );

    expect(step.detail).toBe("/private/artifacts/first.xlsx /private/artifacts/second.pdf");
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

test("image details retain text and metadata without serializing model image bytes", () => {
  const content = [
    { type: "text", text: "Read image file [image/png]" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "image-bytes-fixture" } },
  ];
  const image_view = { view_id: "view-1", name: "image.png", media_type: "image/png" };
  for (const status of ["success", "error"] as const) {
    const step = buildToolDisplayStep("call-1", "read", { path: "image.png" }, status, 1,
      { showResultDetails: true, content, image_view });
    expect(step.image_view).toEqual(status === "success" ? image_view : undefined);
    const block = status === "success" ? step.result_block : step.error_block;
    expect(block?.content).toContain("Read image file");
    expect(block?.content).not.toContain("image-bytes-fixture");
  }
  expect(content[1]?.source?.data).toBe("image-bytes-fixture");
});
