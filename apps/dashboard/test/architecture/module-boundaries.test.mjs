import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { readModuleGraph, dashboardBoundaryViolations } from "./module-graph.mjs";

async function fixture(files, run) {
  const root = mkdtempSync(resolve(tmpdir(), "lxe-boundary-test-"));
  try {
    writeFileSync(resolve(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, module: "esnext", moduleResolution: "bundler", jsx: "react-jsx" }, include: ["src"] }));
    mkdirSync(resolve(root, "src"));
    for (const [path, text] of Object.entries(files)) {
      const target = resolve(root, "src", path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text);
    }
    await run(() => readModuleGraph(resolve(root, "tsconfig.json"), resolve(root, "src")));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Dashboard dependencies preserve transport and state ownership", async () => {
  const graph = await readModuleGraph(resolve(import.meta.dirname, "../../tsconfig.json"), resolve(import.meta.dirname, "../../src"));
  expect(graph.size).toBeGreaterThan(0);
  for (const path of ["main.tsx", "api/client.ts", "api/session-actions.ts", "features/sessions/ConversationPage.tsx"]) expect(graph.has(path)).toBe(true);
  expect(dashboardBoundaryViolations(graph)).toEqual([]);
});

test("boundary scanner tolerates names, whitespace, comments and type-only page interfaces", async () => {
  await fixture({ "api/client.ts": "export const callDashboard = () => {};",
    "api/session-actions.ts": "import { callDashboard as send } from './client'; export { send };",
    "features/sessions/use-session-workspace.ts": "export interface Selection { id: string }",
    "features/sessions/ConversationPage.tsx": "import { type Selection as Choice } from './use-session-workspace';\n// callDashboard useQueryClient\nexport const message = 'callDashboard';",
    "main.tsx": "export const RenamedApp = () => null;" }, async read => {
      expect(dashboardBoundaryViolations(await read())).toEqual([]);
    });
});

for (const statement of ["import { callDashboard as rpc } from '../api/client';", "import * as rpc from '../api/client';",
  "export { callDashboard as rpc } from '../api/client';", "const rpc = import('../api/client');", "const rpc = require('../api/client');",
  "import rpc = require('../api/client');"]) {
  test(`raw transport is protected across syntax: ${statement}`, async () => {
    await fixture({ "api/client.ts": "export const callDashboard = () => {};", "view/index.ts": statement }, async read => {
      expect(dashboardBoundaryViolations(await read()).some(e => e.includes("raw transport"))).toBe(true);
    });
  });
}

test("barrels cannot hide cache ownership and type imports cannot depend on App", async () => {
  await fixture({ "main.tsx": "import { cache as renamed } from './barrel'; export type AppState = {};",
    "barrel.ts": "export * as cache from '@tanstack/react-query';", "reverse.ts": "type App = import('./main').AppState;" }, async read => {
      const errors = dashboardBoundaryViolations(await read());
      expect(errors.some(e => e.includes("cache ownership"))).toBe(true);
      expect(errors.some(e => e.includes("must not depend on App"))).toBe(true);
    });
});

for (const files of [{}, { "a.ts": "import './missing';" }, { "a.ts": "export const = ;" }]) {
  test(`invalid scans fail explicitly: ${JSON.stringify(files)}`, async () => {
    await fixture(files, async read => {
      let failure;
      try { await read(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
    });
  });
}
