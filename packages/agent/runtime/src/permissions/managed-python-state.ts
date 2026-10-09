import { join } from "node:path";

/** Fixed host-owned roots shared by Runtime and the standalone native runner. */
export function managedPythonStateRoots(dataRoot: string): string[] {
  return [join(dataRoot, "lxeskill"), join(dataRoot, "db", "lxeskill"), join(dataRoot, "logs")];
}
