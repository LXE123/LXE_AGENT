import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { assertNoRuntimeSchemaCompiler } from "../vite/renderer-csp-guard";

test("rejects Ajv in production chunks, including Windows and virtual module paths", () => {
  for (const id of [
    "/repo/node_modules/ajv/dist/2020.js",
    "\0C:\\repo\\node_modules\\ajv\\dist\\compile\\index.js?commonjs-proxy",
  ]) {
    expect(() => assertNoRuntimeSchemaCompiler([id])).toThrow("violates script-src 'self'");
  }
  expect(() => assertNoRuntimeSchemaCompiler(["/repo/packages/foundation/protocol/src/context-display.ts"]))
    .not.toThrow();
});

test("context display module initializes with runtime code generation disabled", async () => {
  const build = await Bun.build({
    entrypoints: [new URL("../src/features/sessions/context-display.ts", import.meta.url).pathname],
    target: "browser",
    format: "cjs",
    write: false,
  });
  expect(build.success).toBe(true);
  expect(build.outputs).toHaveLength(1);
  const context = { module: { exports: {} as Record<string, Function> }, exports: {} };
  runInNewContext(await build.outputs[0]!.text(), context, { contextCodeGeneration: { strings: false, wasm: false } });
  expect(context.module.exports.selectContextDisplay!(null, null))
    .toEqual({ metrics: null, usage: null, restored: true });
});
