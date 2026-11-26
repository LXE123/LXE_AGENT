import { managedPythonEnvironment } from "@lxe/core";
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Every desktop business CLI child must use the same business database. */
export function businessCliEnvironment(options: {
  dataRoot: string; managedPath: string; environment: () => NodeJS.ProcessEnv;
}, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const temporary = join(options.dataRoot, "tmp");
  mkdirSync(temporary, { recursive: true });
  const inherited = { ...process.env, ...options.environment(), ...overrides };
  const environment = managedPythonEnvironment({ ...inherited,
    LXE_DATA_ROOT: options.dataRoot, LXE_SQLITE_DB_PATH: join(options.dataRoot, "db", "lxeskill.sqlite3"),
    LXE_WORKSPACE_ROOT: join(options.dataRoot, "workspace"), LXE_MANAGED_PATH: options.managedPath,
    PATH: [options.managedPath, inherited.PATH].filter(Boolean).join(delimiter),
    TEMP: temporary, TMP: temporary, TMPDIR: temporary, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
  delete environment.LXE_AGENT_SQLITE_DB_PATH;
  return environment;
}
