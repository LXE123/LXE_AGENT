import { afterEach, expect, test } from "bun:test";
import type { DesktopFilesApi, FileMetadata, FileFailure, SessionFileRef } from "@lxe/desktop-protocol";
import { checkFile, loadFileApplications, fileSnapshot, reportFileFailure, forgetFileSession } from "../../../src/features/file-preview/application-state";
import { FilePreviewError, setFileBridgeForTests, unwrapFileResult } from "../../../src/features/file-preview/api";
const ref: SessionFileRef = { session_id: "availability-test", kind: "artifact", id: "a" };
const missing: FileFailure = { kind: "not_found", operation: "stat", diagnostic: "ENOENT: fixture target absent" };
const info: FileMetadata = { key: "k", name: "f.txt", size: 5, version: "1", kind: "text", extension: ".txt", source: "current_file" };
afterEach(() => { setFileBridgeForTests(); forgetFileSession(ref.session_id); });
function bridge(call: (value: any) => Promise<any>) { setFileBridgeForTests({ call, read: async () => new Uint8Array(), readText: async () => { throw new Error("unused"); } } as DesktopFilesApi); }
test("IPC unwrapping preserves binary data and failure semantics", () => {
  const bytes = new Uint8Array([0, 255]); expect(unwrapFileResult(structuredClone({ ok: true, value: bytes }))).toEqual(bytes);
  try { unwrapFileResult(structuredClone({ ok: false, error: missing })); throw new Error("expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(FilePreviewError); expect((error as FilePreviewError).failure).toEqual(missing); }
});
test("overlapping cards share a request, deletion clears native apps, and stale query cannot restore them", async () => {
  let resolve!: (value: unknown) => void, calls = 0;
  bridge(async call => { calls++; return call.operation === "stat" ? info : new Promise(r => { resolve = r; }); });
  await Promise.all([checkFile(ref), checkFile(ref)]); expect(calls).toBe(1);
  const old = loadFileApplications(ref); const joined = loadFileApplications(ref);
  reportFileFailure(ref, missing); resolve([{ id: "stale" }]); await Promise.all([old, joined]);
  expect(fileSnapshot(ref).apps).toEqual([]); expect(fileSnapshot(ref).sourceError?.kind).toBe("not_found");
  bridge(async call => call.operation === "stat" ? info : []);
  await checkFile(ref, true); await loadFileApplications(ref);
  expect(fileSnapshot(ref).sourceError).toBeUndefined(); expect(fileSnapshot(ref).previewError).toBeUndefined(); expect(fileSnapshot(ref).loaded).toBe(true);
});
test("a late missing stat cannot overwrite a newer recovery", async () => {
  let reject!: (error: unknown) => void;
  bridge(async () => new Promise((_resolve, r) => { reject = r; }));
  const old = checkFile(ref);
  bridge(async () => info);
  await checkFile(ref, true); reject(new FilePreviewError(missing));
  expect(await old).toEqual(info); expect(fileSnapshot(ref).sourceError).toBeUndefined();
});
test("fresh checks preserve the snapshot until metadata or availability actually changes", async () => {
  let version = "1", diagnostic = missing.diagnostic, stats = 0;
  bridge(async call => {
    stats++;
    if (call.input.original && diagnostic) throw new FilePreviewError({ ...missing, diagnostic });
    return { ...info, version, source: "history" };
  });
  await checkFile(ref);
  const original = fileSnapshot(ref);
  await checkFile(ref, "fresh");
  expect(stats).toBe(4);
  expect(fileSnapshot(ref)).toBe(original);
  version = "2";
  await checkFile(ref, "fresh");
  const updated = fileSnapshot(ref);
  expect(updated.metadata?.version).toBe("2");
  expect(updated.sourceError).toBe(original.sourceError);
  diagnostic = "ENOENT: original directory removed";
  await checkFile(ref, "fresh");
  expect(fileSnapshot(ref).sourceError?.diagnostic).toBe(diagnostic);
  diagnostic = "";
  await checkFile(ref, "fresh");
  expect(fileSnapshot(ref).sourceError).toBeUndefined();
});
test("history preview and original availability are independent; app failures stay separate", async () => {
  bridge(async call => {
    if (call.operation === "applications") throw new Error("ENOENT: spawn missing-association-helper");
    if (call.input.original) throw new FilePreviewError(missing);
    return { ...info, kind: "image", source: "history" };
  });
  await checkFile(ref); expect(fileSnapshot(ref).sourceError?.kind).toBe("not_found"); expect(fileSnapshot(ref).previewError).toBeUndefined();
  await loadFileApplications(ref, true); expect(fileSnapshot(ref).error?.kind).toBe("unknown"); expect(fileSnapshot(ref).metadata?.source).toBe("history");
});

test("resolved artifact and workspace aliases share queries and availability", async () => {
  let applications = 0;
  bridge(async call => { if (call.operation === "applications") { applications++; return []; } return info; });
  const alias: SessionFileRef = { session_id: ref.session_id, kind: "workspace", path: "f.txt" };
  await checkFile(ref); await checkFile(alias);
  expect(fileSnapshot(ref)).toBe(fileSnapshot(alias));
  await Promise.all([loadFileApplications(ref), loadFileApplications(alias)]); expect(applications).toBe(1);
  reportFileFailure(alias, missing); expect(fileSnapshot(ref).sourceError?.kind).toBe("not_found");
});
test("deleting a session does not let in-flight reads recreate its state", async () => {
  let resolve!: (value: unknown) => void;
  bridge(async () => new Promise(r => { resolve = r; }));
  const pending = checkFile(ref); forgetFileSession(ref.session_id); resolve(info);
  await expect(pending).rejects.toThrow("released"); expect(fileSnapshot(ref).metadata).toBeUndefined();
});
