/** Real bundled-engine preview acceptance. Run after creating verify-office-runtime.py fixtures. */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { FilePreviewService } from "../apps/desktop/src/main/file-preview/service";
import { OfficePreviewCache } from "../apps/desktop/src/main/file-preview/office-cache";
const root = resolve(process.argv[2] ?? "build/file-preview-validation/中文 samples");
const runtime = resolve(process.argv[3] ?? `build/desktop-runtime/${process.platform}-${process.arch}`);
const output = resolve(process.argv[4] ?? "build/file-preview-validation/results");
await mkdir(output, { recursive: true });
const service = new FilePreviewService(() => ({
  resolveWorkspaceDirectory: async session => { if (session !== "acceptance") throw new Error("Unknown session"); return root; },
  resolveArtifact: async () => undefined, resolveAttachment: async () => undefined, resolveImagePreview: async () => undefined,
}), new OfficePreviewCache(join(output, "cache"), join(runtime, "office/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js")), { openPath: async () => { throw new Error("No UI launch during conversion test"); }, revealPath: () => {} });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const reports = [];
try {
  for (const name of ["修改 文档.docx", "修改 幻灯片.pptx", "旧 文档.doc", "旧 幻灯片.ppt"]) {
    const before = sha(await readFile(join(root, name))), ref = { session_id: "acceptance", kind: "workspace" as const, path: name };
    const started = Date.now();
    const preview = await service.call({ operation: "prepare", input: { ref, request_id: "first" } });
    const bytes = await service.read(preview.handle);
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error(`Not a PDF: ${name}`);
    if (before !== sha(await readFile(join(root, name)))) throw new Error(`Source modified: ${name}`);
    await writeFile(join(output, name + ".pdf"), bytes);
    service.release("first");
    const second = await service.call({ operation: "prepare", input: { ref, request_id: "cached" } });
    if (sha(bytes) !== sha(await service.read(second.handle))) throw new Error("Cache bytes differ");
    service.release("cached");
    reports.push({ name, bytes: bytes.length, sourceHash: before, elapsedMs: Date.now() - started, missingFonts: preview.missingFonts });
  }
  await writeFile(join(root, "损坏.docx"), "not a document");
  try { await service.call({ operation: "prepare", input: { ref: { session_id: "acceptance", kind: "workspace", path: "损坏.docx" }, request_id: "broken" } }); throw new Error("Corrupt file falsely succeeded"); }
  catch (error) { if (String(error).includes("falsely succeeded")) throw error; reports.push({ corruptDocumentDiagnostic: String(error) }); }
  const report = { platform: process.platform, arch: process.arch, engine: "0.1.5", reports };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await service.dispose(); }
