import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const isRepositoryRoot = (directory: string): boolean =>
  existsSync(join(directory, "package.json"))
  && existsSync(join(directory, "bun.lock"))
  && existsSync(join(directory, "python", "lxeskill_cli", "lxeskill", "catalog.json"));

export function repositoryRoot(start: string = process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (isRepositoryRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`LXE repository root not found from: ${start}`);
    current = parent;
  }
}
