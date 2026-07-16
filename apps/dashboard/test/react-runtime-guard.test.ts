import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSingleReactRuntime,
  collectReactRuntimeRoots,
} from "../vite/react-runtime-guard";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `lxe-${label}-`));
  temporaryRoots.push(root);
  for (const packageName of ["react", "react-dom"]) {
    const packageRoot = join(root, "node_modules", packageName);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: packageName }));
  }
  return join(root, "node_modules");
}

describe("production React runtime guard", () => {
  test("normalizes virtual module ids to one real package root", () => {
    const modules = runtimeRoot("single-react-runtime");
    const roots = assertSingleReactRuntime([
      join(modules, "react", "index.js"),
      `\0${join(modules, "react", "jsx-runtime.js")}?commonjs-proxy`,
      join(modules, "react-dom", "client.js"),
    ]);

    expect(roots.react).toEqual([realpathSync.native(join(modules, "react"))]);
    expect(roots["react-dom"]).toEqual([realpathSync.native(join(modules, "react-dom"))]);
  });

  test("rejects bundles containing React from two physical roots", () => {
    const first = runtimeRoot("first-react-runtime");
    const second = runtimeRoot("second-react-runtime");
    const moduleIds = [
      join(first, "react", "index.js"),
      join(first, "react-dom", "client.js"),
      join(second, "react", "index.js"),
    ];

    expect(collectReactRuntimeRoots(moduleIds).react).toHaveLength(2);
    expect(() => assertSingleReactRuntime(moduleIds))
      .toThrow("Production Renderer must contain exactly one react runtime; found 2");
  });
});
