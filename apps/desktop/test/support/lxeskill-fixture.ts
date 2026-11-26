import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LxeSkillClient, type LxeSkillClientOptions } from "../../src/main/lxeskill/lxeskill-client";

const roots: string[] = [];

/** Remove every fixture directory created by `fixtureClient`. Call it from `afterEach`. */
export const removeFixtures = (): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};

export const resultLine = (fields: Record<string, unknown>): string =>
  JSON.stringify({ protocol_version: "1", type: "result", command: "fixture", ok: true, data: {}, files: [], ...fields });

/**
 * A client whose "lxeskill" is a script run by the current JS runtime. The script receives the
 * command arguments in `args`, and `emit(record)` writes one protocol record to stdout.
 */
export function fixtureClient(script: string, overrides: Partial<LxeSkillClientOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "lxe-cli-fixture-"));
  roots.push(root);
  const dataRoot = join(root, "data");
  mkdirSync(dataRoot);
  const runner = join(root, "lxeskill-fixture.mjs");
  writeFileSync(runner, `
const args = process.argv.slice(2);
const emit = record => process.stdout.write(JSON.stringify({ protocol_version: "1", ...record }) + "\\n");
${script}
`, "utf8");
  const client = new LxeSkillClient({
    executablePath: process.execPath, commandPrefix: [runner], dataRoot, managedPath: join(root, "managed"),
    ...overrides,
  });
  return { client, root, dataRoot };
}

export const sourceLxeSkillPath = (): string =>
  join(process.cwd(), ".venv", process.platform === "win32" ? "Scripts/lxeskill.exe" : "bin/lxeskill");
