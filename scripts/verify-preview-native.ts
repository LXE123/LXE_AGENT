/** Execute the built file with Electron on the target OS; no application preferences are changed. */
import { app, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { FilePreviewService } from "../apps/desktop/src/main/file-preview/service";
import { OfficePreviewCache } from "../apps/desktop/src/main/file-preview/office-cache";
const root = resolve(process.argv[2] ?? "build/file-preview-polish/native");
app.setPath("userData", join(root, "profile"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  await mkdir(root, { recursive: true });
  const path = join(root, "中文 preview.txt"), unknown = `unknown.lxe${randomUUID().replaceAll("-", "")}`;
  await writeFile(path, "LXE native file preview acceptance\n"); await writeFile(join(root, unknown), "No registered application");
  const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex"), before = hash(await readFile(path));
  const service = new FilePreviewService(() => ({
    resolveWorkspaceDirectory: async id => { if (id !== "native-test") throw new Error("Unknown test session"); return root; },
    resolveArtifact: async () => undefined, resolveAttachment: async () => undefined, resolveImagePreview: async () => undefined,
  }), new OfficePreviewCache(join(root, "cache"), "unused"), { openPath: path => shell.openPath(path), revealPath: path => shell.showItemInFolder(path) });
  const ref = { session_id: "native-test", kind: "workspace" as const, path: "中文 preview.txt" };
  try {
    const applications = await service.call({ operation: "applications", input: { ref } });
    const selected = applications.find(app => app.default) ?? applications[0];
    if (!selected || !applications.some(app => app.icon)) throw new Error("Native applications or icons missing");
    await service.call({ operation: "open", input: { ref, application: selected.id } });
    await service.call({ operation: "open", input: { ref } });
    await service.call({ operation: "open", input: { ref, reveal: true } });
    await service.call({ operation: "open-workspace", input: { session_id: "native-test" } });
    const empty = await service.call({ operation: "applications", input: { ref: { ...ref, path: unknown } } });
    if (empty.length) throw new Error("Unique test extension unexpectedly has an association");
    let rejected = "";
    try { await service.call({ operation: "open", input: { ref, application: join(root, "unregistered-application") } }); }
    catch (error) { rejected = String(error); }
    if (!rejected.includes("not registered")) throw new Error(`Unregistered application was not rejected: ${rejected}`);
    if (hash(await readFile(path)) !== before) throw new Error("Native opening changed the source");
    const report = { platform: process.platform, associatedApps: applications.length, preferred: selected.name, icons: applications.filter(a => a.icon).length, selectedOpen: true, defaultOpen: true, reveal: true, workspaceOpen: true, noAssociation: true, invalidApplicationDiagnostic: rejected, sourceHash: before };
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { await service.dispose(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
