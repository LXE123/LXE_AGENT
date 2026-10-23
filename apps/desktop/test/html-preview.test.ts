import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilePreviewService } from "../src/main/file-preview/service";
import { OfficePreviewCache } from "../src/main/file-preview/office-cache";
import { HTML_ASSET_BYTES, HTML_MAX_BYTES, prepareHtmlDocument } from "../src/main/file-preview/html-preview";
import type { HtmlPreviewReference, SessionFileRef } from "@lxe/desktop-protocol";

const roots: string[] = [], services: FilePreviewService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lxe-html-中文 ")); roots.push(root);
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(join(workspace, "报告"), { recursive: true }); await mkdir(outside);
  await writeFile(join(workspace, "报告", "test.htm"), '<link rel="stylesheet" href="../样式%20表.css"><script src="../code.js"></script>');
  await writeFile(join(workspace, "样式 表.css"), "body { color: red }");
  await writeFile(join(workspace, "code.js"), 'document.title="中文"');
  await writeFile(join(outside, "report.html"), "<h1>Artifact</h1>");
  await writeFile(join(outside, "outside.js"), "window.secret=1");
  let exists = true;
  const service = new FilePreviewService(() => ({
    resolveWorkspaceDirectory: async id => { if (id !== "s" || !exists) throw new Error("Session not found"); return workspace; },
    resolveArtifact: async (s, id) => s === "s" && id === "a" && exists ? join(outside, "report.html") : undefined,
    resolveAttachment: async () => undefined, resolveImagePreview: async () => undefined,
  }), new OfficePreviewCache(join(root, "cache"), "cli"), { openPath: async () => "", revealPath: () => {} });
  services.push(service);
  const ref: SessionFileRef = { session_id: "s", kind: "workspace", path: "报告/test.htm" };
  const preview = await service.call({ operation: "prepare", input: { ref, request_id: "html" } });
  const prepare = (references: HtmlPreviewReference[]) => service.call({ operation: "html.prepare", input: { handle: preview.handle, references } });
  return { root, workspace, outside, service, ref, preview, prepare, removeSession: () => { exists = false; } };
}
const css: HtmlPreviewReference = { kind: "stylesheet", reference: "../样式%20表.css" }, js: HtmlPreviewReference = { kind: "script", reference: "../code.js" };
const token = (url: string) => new URL(url).pathname.slice(1);

test("HTML packages are handle-bound, UTF-8, versioned and revoked on close", async () => {
  const f = await fixture(); expect(f.preview.metadata.kind).toBe("html");
  const p = await f.prepare([css, js, css]);
  const document = await f.service.htmlDocument(token(p.url));
  expect(document).toContain("document.write"); expect(document).not.toContain("../code.js");
  expect((await f.service.call({ operation: "html.version", input: { handle: f.preview.handle } })).version).toBe(p.version);
  await writeFile(join(f.workspace, "code.js"), "// updated script");
  expect((await f.service.call({ operation: "html.version", input: { handle: f.preview.handle } })).version).not.toBe(p.version);
  await expect(f.service.htmlDocument(token(p.url))).rejects.toThrow("changed");
  const next = await f.prepare([css, js]); expect(next.url).not.toBe(p.url);
  await expect(f.service.htmlDocument(token(p.url))).rejects.toThrow("closed");
  f.service.release("html"); await expect(f.service.htmlDocument(token(next.url))).rejects.toThrow("closed");
  await expect(f.prepare([])).rejects.toThrow("closed");
});
test("relative resources cannot escape workspace or use filesystem/network URLs", async () => {
  const f = await fixture();
  for (const reference of ["../../outside/outside.js", "%2e%2e/%2e%2e/outside/outside.js", "file:///tmp/a.js", "https://site/a.js", "//host/a.js", "C:/a.js", "../a.png", "../a\\b.js", "%00.js", "%invalid.js"]) {
    await expect(f.prepare([{ kind: "script", reference }])).rejects.toThrow();
  }
  await symlink(f.outside, join(f.workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  await expect(f.prepare([{ kind: "script", reference: "../escape/outside.js" }])).rejects.toThrow("outside");
  await expect(f.service.read(f.preview.handle, "../image.png")).rejects.toThrow("Invalid Markdown");
});
test("external artifacts stay in their directory and recheck session authorization", async () => {
  const f = await fixture(), ref: SessionFileRef = { session_id: "s", kind: "artifact", id: "a" };
  const p = await f.service.call({ operation: "prepare", input: { ref, request_id: "artifact" } });
  const call = (reference: string) => f.service.call({ operation: "html.prepare", input: { handle: p.handle, references: [{ kind: "script", reference }] } });
  await expect(call("../workspace/code.js")).rejects.toThrow("outside");
  const html = await call("outside.js");
  await expect(f.service.call({ operation: "prepare", input: { ref: { ...ref, session_id: "other" }, request_id: "other" } })).rejects.toThrow("not part");
  f.removeSession(); await expect(f.service.htmlDocument(token(html.url))).rejects.toThrow("not part");
});
test("missing, invalid UTF-8, oversized and cancelled bundles report real errors without publishing", async () => {
  const f = await fixture();
  await expect(f.prepare([{ kind: "script", reference: "absent.js" }])).rejects.toThrow("ENOENT");
  const { fileResult } = await import("../src/main/file-preview/errors");
  const missing = await fileResult("html.prepare", () => f.prepare([{ kind: "script", reference: "absent.js" }]));
  expect(missing.ok).toBe(false);
  if (!missing.ok) { expect(missing.error.kind).toBe("unknown"); expect(missing.error.diagnostic).toContain("absent.js"); expect(missing.error.diagnostic).toContain("ENOENT"); }
  await writeFile(join(f.workspace, "code.js"), Buffer.from([255, 254, 0])); await expect(f.prepare([js])).rejects.toThrow();
  await writeFile(join(f.workspace, "code.js"), Buffer.alloc(HTML_ASSET_BYTES + 1)); await expect(f.prepare([js])).rejects.toThrow("limit");
  await expect(f.prepare(Array.from({ length: 65 }, (_, i) => ({ kind: "script", reference: `${i}.js` })))).rejects.toThrow("64 resources");
  await expect(prepareHtmlDocument(Buffer.from([255]), "test.html", f.workspace, "v", [], new AbortController().signal)).rejects.toThrow();
  await writeFile(join(f.workspace, "code.js"), "x".repeat(HTML_ASSET_BYTES));
  await expect(prepareHtmlDocument(Buffer.alloc(HTML_MAX_BYTES - 1, 32), join(f.workspace, "test.html"), f.workspace, "v", [{ kind: "script", reference: "code.js" }], new AbortController().signal)).rejects.toThrow("32 MiB");
  const pending = f.prepare([js]); f.service.release("html"); await expect(pending).rejects.toThrow();
});
test("root changes, deletion, dependency deletion and symlink replacement invalidate the package", async () => {
  const f = await fixture();
  const p = await f.prepare([js]); await rm(join(f.workspace, "code.js"));
  await expect(f.service.htmlDocument(token(p.url))).rejects.toThrow("ENOENT");
  await writeFile(join(f.workspace, "code.js"), "x");
  await writeFile(join(f.workspace, "报告", "test.htm"), "new HTML");
  await expect(f.prepare([])).rejects.toThrow("changed");
  await rm(join(f.workspace, "报告", "test.htm"));
  await expect(f.service.htmlDocument(token(p.url))).rejects.toThrow();
});
