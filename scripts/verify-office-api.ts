/** Build for Node ESM with electron external, then run with the target Electron. */
import { app } from "electron";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { OfficePreviewCache } from "../apps/desktop/src/main/file-preview/office-cache";
import { createOfficeConverter } from "../apps/desktop/src/main/file-preview/office-kit";

const [fixtures, runtime, output] = process.argv.slice(2).map(path => resolve(path));
if (!fixtures || !runtime || !output) throw new Error("Expected fixtures, runtime root and output directory");
app.setPath("userData", join(output, "profile"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  const cli = join(runtime, "office/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js");
  const reports: unknown[] = [];
  let onRender: (() => void) | undefined;
  const cacheRoot = join(output, "cache");
  const cache = new OfficePreviewCache(cacheRoot, cli, async path => {
    const converter = await createOfficeConverter(path);
    return {
      render: (options, signal) => { onRender?.(); return converter.render(options, signal); },
      dispose: () => converter.dispose(),
    };
  });
  const signal = () => new AbortController().signal;
  try {
    for (const [name, extension] of [["修改 文档.docx", ".docx"], ["修改 幻灯片.pptx", ".pptx"]] as const) {
      const bytes = await readFile(join(fixtures, name));
      const preview = await cache.get(bytes, extension, signal());
      assert.equal(Buffer.from(preview.bytes.subarray(0, 5)).toString(), "%PDF-");
      assert(preview.bytes.length > 1000);
      const cached = await cache.get(bytes, extension, signal());
      assert.deepEqual(cached.bytes, preview.bytes);
      assert.deepEqual(await readFile(join(fixtures, name)), bytes);
      await writeFile(join(output, name + ".pdf"), preview.bytes);
      reports.push({ name, bytes: preview.bytes.length, missingFonts: preview.missingFonts });
      cached.release(); preview.release();
    }
    await assert.rejects(cache.get(Buffer.from("not a document"), ".docx", signal()), error => {
      reports.push({ corruptDocumentDiagnostic: String(error) }); return true;
    });
    const large = await readFile(join(fixtures, "取消测试.docx"));
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    onRender = ready;
    const controller = new AbortController();
    const pending = cache.get(large, ".docx", controller.signal);
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => {});
    const rejected = assert.rejects(pending);
    await started;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(settled, false, "Cancellation fixture completed before cancellation");
    controller.abort(new Error("Acceptance cancellation"));
    await rejected;
    onRender = undefined;
    // A new conversion must work after cancellation has drained the worker.
    const recovered = await cache.get(await readFile(join(fixtures, "原始 文档.docx")), ".docx", signal());
    recovered.release();
    const disposeStarted = new Promise<void>(resolve => { onRender = resolve; });
    const duringDispose = assert.rejects(cache.get(large, ".docx", signal()));
    await disposeStarted;
    await new Promise(resolve => setTimeout(resolve, 200));
    await cache.dispose();
    await duringDispose;
    assert((await readdir(cacheRoot)).every(name => /^[a-f0-9]{64}\.(pdf|json)$/.test(name)), "Temporary input/output leaked");
    // Verify the actual Kit timeout contract used by the production adapter.
    const entry = createRequire(cli).resolve("@deepseek-ai/libreoffice-kit");
    const { createConverter } = await import(pathToFileURL(entry).href);
    const timed = await createConverter({ timeoutMs: 1 });
    try {
      await assert.rejects(timed.render({ inputPath: join(fixtures, "修改 文档.docx"), outputPath: join(output, "timeout.pdf") }), (error: any) => {
        assert.equal(error.code, "timeout"); reports.push({ timeoutDiagnostic: String(error) }); return true;
      });
    } finally { await timed.dispose(); }
    const report = { status: "passed", platform: process.platform, versions: process.versions, reports, cancellationRecovered: true, disposed: true };
    await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.quit();
  } catch (error) {
    console.error(error);
    await cache.dispose();
    app.exit(1);
  }

}).catch(error => { console.error(error); app.exit(1); });
