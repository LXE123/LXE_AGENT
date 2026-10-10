import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("the document favicon resolves to a valid bundled application PNG", async () => {
  const root = resolve(import.meta.dir, "../..");
  const icons: Array<{ href: string | null; type: string | null }> = [];
  await new HTMLRewriter().on('link[rel="icon"]', { element(element) {
    icons.push({ href: element.getAttribute("href"), type: element.getAttribute("type") });
  } }).transform(new Response(await Bun.file(resolve(root, "index.html")).text())).text();
  expect(icons).toEqual([{ href: "/src/assets/brand/lxe-agent-logo.png", type: "image/png" }]);
  const bytes = Buffer.from(await Bun.file(resolve(root, "." + icons[0]!.href)).arrayBuffer());
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(0);
  expect(bytes.readUInt32BE(20)).toBeGreaterThan(0);
});
