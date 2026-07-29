import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopSyntheticPerformerTask } from "@lxe/desktop-protocol";
import {
  DesktopSyntheticPerformerService,
  syntheticPerformerPythonArguments,
  syntheticPerformerTaskDirectoryName,
} from "../src/main/synthetic-performer";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const runnerSource = (scriptBody: string): string => `
for await (const _chunk of process.stdin) {}
${scriptBody}
`;

const fixture = (scriptBody: string) => {
  const root = mkdtempSync(join(tmpdir(), "lxe-synthetic-performer-"));
  roots.push(root);
  const runner = join(root, "cli-fixture.mjs");
  const exiftool = join(root, "exiftool.exe");
  const dataRoot = join(root, "data");
  const sources = join(root, "sources");
  const output = join(root, "output");
  mkdirSync(dataRoot);
  mkdirSync(sources);
  mkdirSync(output);
  writeFileSync(runner, runnerSource(scriptBody), "utf8");
  writeFileSync(exiftool, "fixture", "utf8");
  return {
    root,
    runner,
    python: process.execPath,
    pythonArguments: [runner],
    exiftool,
    dataRoot,
    sources,
    output,
  };
};

const waitForTerminal = (
  service: DesktopSyntheticPerformerService,
): Promise<DesktopSyntheticPerformerTask> => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("task did not finish")), 5_000);
  const poll = () => {
    const task = service.current();
    if (task && ["completed", "cancelled", "failed"].includes(task.state)) {
      clearTimeout(timeout);
      resolve(task);
      return;
    }
    setTimeout(poll, 10);
  };
  poll();
});

describe("desktop synthetic performer service", () => {
  test("keeps the managed Python CLI command as the production default", () => {
    expect(syntheticPerformerPythonArguments).toEqual([
      "-I",
      "-B",
      "-m",
      "lxeskill",
      "media",
      "synthetic-performer",
      "--stdin-json",
    ]);
  });

  test("uses a stable human-readable output directory name", () => {
    expect(syntheticPerformerTaskDirectoryName(new Date(2026, 6, 28, 14, 35, 20)))
      .toBe("AI人物标签-20260728-143520");
  });

  test("keeps paths behind opaque selections and streams a completed scan", async () => {
    const files = fixture(`
console.log('{"protocol_version":"1","type":"progress","command":"media synthetic-performer","stage":"scan","processed":1,"total":1,"current_file":"sample.jpg"}');
console.log('{"protocol_version":"1","type":"result","command":"media synthetic-performer","ok":true,"data":{"items":[{"name":"sample.jpg","relative_path":"sample.jpg","media_type":"image","status":"needs_tag","size_bytes":12,"absolute_path":"/secret/source/sample.jpg"}],"counts":{"needs_tag":1}},"files":[]}');
`);
    const sourceFile = join(files.sources, "sample.jpg");
    writeFileSync(sourceFile, "image", "utf8");
    const updates: DesktopSyntheticPerformerTask[] = [];
    const service = new DesktopSyntheticPerformerService({
      platform: "win32",
      pythonPath: files.python,
      pythonArguments: files.pythonArguments,
      exifToolPath: files.exiftool,
      dataRoot: files.dataRoot,
      managedPath: files.root,
      onTaskChanged: (task) => updates.push(task),
    });
    const selection = service.registerSources("files", [sourceFile]);

    const started = service.start({
      action: "scan",
      selection_id: selection.selection_id,
      recursive: false,
    });
    const completed = await waitForTerminal(service);

    expect(started.state).toBe("running");
    expect(completed.state).toBe("completed");
    expect(completed.items[0]).toMatchObject({ name: "sample.jpg", status: "needs_tag" });
    expect(completed.counts).toEqual({ needs_tag: 1 });
    expect(updates.some((task) => task.stage === "scan" && task.current_file === "sample.jpg")).toBe(true);
    expect(JSON.stringify(selection)).not.toContain(sourceFile.replaceAll("\\", "\\\\"));
    expect(JSON.stringify(completed)).not.toContain(sourceFile.replaceAll("\\", "\\\\"));
    expect(JSON.stringify(completed)).not.toContain("/secret/source");
  });

  test("creates a unique output directory and preserves real CLI errors", async () => {
    const files = fixture(`
console.log('{"protocol_version":"1","type":"result","command":"media synthetic-performer","ok":false,"data":{},"files":[],"error":{"code":"business_cli_failed","message":"ExifTool exited with 9: malformed XMP packet"}}');
process.exitCode = 4;
`);
    const sourceFile = join(files.sources, "sample.mp4");
    writeFileSync(sourceFile, "video", "utf8");
    const service = new DesktopSyntheticPerformerService({
      platform: "win32",
      pythonPath: files.python,
      pythonArguments: files.pythonArguments,
      exifToolPath: files.exiftool,
      dataRoot: files.dataRoot,
      managedPath: files.root,
    });
    const selection = service.registerSources("files", [sourceFile]);
    const output = service.registerOutput(files.output);

    service.start({
      action: "apply",
      selection_id: selection.selection_id,
      output_id: output.output_id,
      recursive: false,
    });
    const failed = await waitForTerminal(service);

    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("ExifTool exited with 9: malformed XMP packet");
    expect(service.outputPath(failed.task_id)).toStartWith(join(files.output, "AI人物标签-"));
    expect(JSON.stringify(failed)).not.toContain(files.output.replaceAll("\\", "\\\\"));
  });

  test("rejects unsupported platforms and expired identifiers", () => {
    const files = fixture("");
    const sourceFile = join(files.sources, "sample.jpg");
    writeFileSync(sourceFile, "image", "utf8");
    const service = new DesktopSyntheticPerformerService({
      platform: "linux",
      pythonPath: files.python,
      pythonArguments: files.pythonArguments,
      exifToolPath: files.exiftool,
      dataRoot: files.dataRoot,
      managedPath: files.root,
    });
    const selection = service.registerSources("files", [sourceFile]);
    expect(() => service.start({ action: "scan", selection_id: selection.selection_id, recursive: false }))
      .toThrow("Windows and macOS only");
    expect(() => service.outputPath("missing")).toThrow("not found");
  });

  test("allows only one task and cancels the Python process", async () => {
    const files = fixture("setInterval(() => undefined, 30_000);");
    const sourceFile = join(files.sources, "sample.mov");
    writeFileSync(sourceFile, "video", "utf8");
    const service = new DesktopSyntheticPerformerService({
      platform: "win32",
      pythonPath: files.python,
      pythonArguments: files.pythonArguments,
      exifToolPath: files.exiftool,
      dataRoot: files.dataRoot,
      managedPath: files.root,
    });
    const selection = service.registerSources("files", [sourceFile]);
    const started = service.start({
      action: "scan",
      selection_id: selection.selection_id,
      recursive: false,
    });

    expect(() => service.start({
      action: "scan",
      selection_id: selection.selection_id,
      recursive: false,
    })).toThrow("already running");
    const cancelled = await service.cancel(started.task_id);

    expect(cancelled?.state).toBe("cancelled");
    expect(service.current()?.state).toBe("cancelled");
  });

  test("cancels the complete Python and ExifTool process group on macOS", async () => {
    if (process.platform === "win32") return;
    const files = fixture("");
    const childPidPath = join(files.root, "exiftool-child.pid");
    writeFileSync(files.runner, runnerSource(`
const { spawn } = await import("node:child_process");
const { writeFileSync } = await import("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 30_000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), "utf8");
setInterval(() => undefined, 30_000);
`), "utf8");
    const sourceFile = join(files.sources, "sample.mov");
    writeFileSync(sourceFile, "video", "utf8");
    const service = new DesktopSyntheticPerformerService({
      platform: "darwin",
      pythonPath: files.python,
      pythonArguments: files.pythonArguments,
      exifToolPath: files.exiftool,
      dataRoot: files.dataRoot,
      managedPath: files.root,
    });
    const selection = service.registerSources("files", [sourceFile]);
    const started = service.start({ action: "scan", selection_id: selection.selection_id, recursive: false });
    const deadline = Date.now() + 2_000;
    while (!existsSync(childPidPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(childPidPath)).toBe(true);
    const grandchildPid = Number(readFileSync(childPidPath, "utf8").trim());

    const cancelled = await service.cancel(started.task_id);
    const processExists = (): boolean => {
      try {
        process.kill(grandchildPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const exitDeadline = Date.now() + 2_000;
    while (processExists() && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(cancelled?.state).toBe("cancelled");
    expect(processExists()).toBe(false);
  });

  test("rejects unsafe item paths returned by the Python boundary", async () => {
    const files = fixture(`
console.log('{"protocol_version":"1","type":"result","command":"media synthetic-performer","ok":true,"data":{"items":[{"name":"secret.jpg","relative_path":"../secret.jpg","media_type":"image","status":"needs_tag","size_bytes":1}],"counts":{"needs_tag":1}},"files":[]}');
`);
    const sourceFile = join(files.sources, "sample.jpg");
    writeFileSync(sourceFile, "image", "utf8");
    const service = new DesktopSyntheticPerformerService({
      platform: "win32",
      pythonPath: files.python,
      pythonArguments: files.pythonArguments,
      exifToolPath: files.exiftool,
      dataRoot: files.dataRoot,
      managedPath: files.root,
    });
    const selection = service.registerSources("files", [sourceFile]);

    service.start({ action: "scan", selection_id: selection.selection_id, recursive: false });
    const failed = await waitForTerminal(service);

    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("relative_path is unsafe");
    expect(failed.items).toEqual([]);
  });
});
