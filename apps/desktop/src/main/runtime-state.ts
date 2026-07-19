import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DesktopRuntimeStatePaths {
  dataRoot: string;
  userData: string;
  sessionData: string;
  diskCache: string;
  electronLogs: string;
  crashDumps: string;
  temporary: string;
}

export interface ElectronRuntimePathPort {
  setPath(name: string, path: string): void;
  commandLine: {
    appendSwitch(name: string, value?: string): void;
    removeSwitch(name: string): void;
  };
}

export interface RuntimeStateIo {
  mkdir(path: string): void;
  writeProbe(path: string): void;
  removeProbe(path: string): void;
}

const defaultIo: RuntimeStateIo = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writeProbe: (path) => writeFileSync(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 }),
  removeProbe: (path) => rmSync(path, { force: true }),
};

export function desktopRuntimeStatePaths(dataRoot: string): DesktopRuntimeStatePaths {
  return {
    dataRoot,
    userData: join(dataRoot, "electron", "user-data"),
    sessionData: join(dataRoot, "electron", "session-data"),
    diskCache: join(dataRoot, "electron", "cache"),
    electronLogs: join(dataRoot, "logs", "electron"),
    crashDumps: join(dataRoot, "logs", "crash-dumps"),
    temporary: join(dataRoot, "tmp"),
  };
}

export function prepareDesktopRuntimeState(
  dataRoot: string,
  io: RuntimeStateIo = defaultIo,
): DesktopRuntimeStatePaths {
  const paths = desktopRuntimeStatePaths(dataRoot);
  for (const path of [
    paths.dataRoot,
    join(paths.dataRoot, "config"),
    join(paths.dataRoot, "db"),
    join(paths.dataRoot, "logs"),
    join(paths.dataRoot, "artifacts"),
    join(paths.dataRoot, "lxeskill"),
    join(paths.dataRoot, "migrations"),
    paths.userData,
    paths.sessionData,
    paths.diskCache,
    paths.electronLogs,
    paths.crashDumps,
    paths.temporary,
  ]) io.mkdir(path);

  const probe = join(paths.dataRoot, `.lxe-write-probe-${process.pid}-${randomUUID()}`);
  try {
    io.writeProbe(probe);
    io.removeProbe(probe);
  } catch (cause) {
    try {
      io.removeProbe(probe);
    } catch {
      // Preserve the original filesystem error, which is the actionable failure.
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`LXE_DATA_ROOT is not writable: ${paths.dataRoot}: ${detail}`, { cause });
  }
  return paths;
}

export function configureElectronRuntimeState(
  electronApp: ElectronRuntimePathPort,
  paths: DesktopRuntimeStatePaths,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  electronApp.setPath("userData", paths.userData);
  electronApp.setPath("sessionData", paths.sessionData);
  electronApp.setPath("temp", paths.temporary);
  electronApp.setPath("logs", paths.electronLogs);
  electronApp.setPath("crashDumps", paths.crashDumps);
  electronApp.commandLine.removeSwitch("user-data-dir");
  electronApp.commandLine.removeSwitch("disk-cache-dir");
  electronApp.commandLine.appendSwitch("disk-cache-dir", paths.diskCache);
  environment.LXE_DATA_ROOT = paths.dataRoot;
  environment.TMP = paths.temporary;
  environment.TEMP = paths.temporary;
  environment.TMPDIR = paths.temporary;
}
