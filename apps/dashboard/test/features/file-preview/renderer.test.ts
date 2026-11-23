import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { build } from "vite";
import ExcelJS from "exceljs";
let output: string, protocolFile: string;
const require = createRequire(import.meta.url);
function pdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"], kids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const pageId = objects.length + 1, content = "BT /F1 24 Tf 30 500 Td (Preview sample " + (i + 1) + ") Tj ET";
    kids.push(pageId + " 0 R");
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Rotate " + (i === 1 ? 90 : 0) + " /Resources << /Font << /F1 3 0 R >> >> /Contents " + (pageId + 1) + " 0 R >>");
    objects.push("<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream");
  }
  objects[1] = "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count 20 >>";
  let value = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, i) => { offsets.push(value.length); value += (i + 1) + " 0 obj\n" + object + "\nendobj\n"; });
  const start = value.length;
  value += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n" + offsets.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("") + "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + start + "\n%%EOF";
  return value;
}

beforeAll(async () => {
  output = mkdtempSync(resolve(tmpdir(), "lxe-preview-renderer-"));
  await build({ root: resolve(import.meta.dirname, "../../.."), logLevel: "error", build: { outDir: output, emptyOutDir: true, target: "es2022", minify: false, rollupOptions: { input: resolve(import.meta.dirname, "renderer.html") } } });
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet("Sales");
  sheet.addRows([["SKU", "Units", "Total"], ["001", 5, { formula: "B2*2", result: 10 }]]);
  workbook.addWorksheet("Notes").getCell("A1").value = "Keep this worksheet";
  for (let i = 1; i <= 6; i++) workbook.addWorksheet(`区域备货明细 ${i}`).getCell("A1").value = i;
  const fixtures: Record<string, any> = { "book.xlsx": await workbook.xlsx.writeBuffer(), "table.csv": "SKU,Value\n001,20\n", "文档.md": "# Preview heading\n\n![Local image](图.png)\n\nInline math $x^2$\n" + "\n段落内容 ".repeat(4992) + "\n```ts\nconst first = 1;\nconst last = 2;\n```\n", "doc.pdf": pdf(), "图.png": Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5ZkAAAAASUVORK5CYII=", "base64"), "archive.zip": "<h1>Never execute</h1>" };
  if (process.env.LXE_PREVIEW_OFFICE_PDF) fixtures["doc.pdf"] = await Bun.file(process.env.LXE_PREVIEW_OFFICE_PDF).arrayBuffer();
  for (const [name, value] of Object.entries(fixtures)) await Bun.write(resolve(output, "fixtures", name), value);
  const protocol = await Bun.build({ entrypoints: [resolve(import.meta.dirname, "../../../../desktop/src/main/app-protocol.ts")], outdir: resolve(output, "main"), target: "node", format: "cjs", external: ["electron"] });
  if (!protocol.success) throw new Error(protocol.logs.map(String).join("\n"));
  protocolFile = protocol.outputs[0]!.path;
  // A full Vite build plus fixtures; hosted CI machines can need over a minute.
}, 150_000);
afterAll(() => { if (output) rmSync(output, { recursive: true, force: true }); });
test("file previews work in the isolated Chromium renderer with React 19", async () => {
  const profile = mkdtempSync(resolve(tmpdir(), "lxe-preview-profile-")), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = Bun.spawn([require(resolve(import.meta.dirname, "../../../../desktop/node_modules/electron")), resolve(import.meta.dirname, "runner.cjs"), profile, output, protocolFile], { env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 100_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    const report = stdout.split("\n").find(line => line.startsWith("LXE_PREVIEW_RESULT="));
    expect(report).toBeDefined();
    expect(JSON.parse(report!.slice(19)).passed.length).toBe(21);
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); }
}, 115_000);
