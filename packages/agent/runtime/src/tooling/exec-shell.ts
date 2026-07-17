import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export const DEFAULT_EXEC_TIMEOUT_SECONDS = 120;
export const MAX_EXEC_TIMEOUT_SECONDS = 3_600;
export const DEFAULT_EXEC_YIELD_MS = 10_000;

type Environment = Record<string, string | undefined>;
type SpawnedProcess = ReturnType<typeof Bun.spawn>;

export interface ExecSpawnSpec {
  argv: string[];
  detached: boolean;
}

export interface ExecEnvironmentContext {
  sessionId: string;
  turnId: string;
  responseRouteId: string;
  execSessionId: string;
}

export interface ExecShellAdapterOptions {
  platform?: NodeJS.Platform;
  environment?: Environment;
  fileExists?: (path: string) => boolean;
  which?: (command: string) => string | null;
  powerShellMajor?: (executable: string) => number | undefined;
  terminationGraceMs?: number;
}

const outputText = (value: Uint8Array | undefined): string =>
  value ? new TextDecoder().decode(value).trim() : "";

const defaultPowerShellMajor = (executable: string): number | undefined => {
  try {
    const result = Bun.spawnSync([
      executable,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.Major",
    ], { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    if (result.exitCode !== 0) return undefined;
    const major = Number.parseInt(outputText(result.stdout).split(/\r?\n/u)[0] ?? "", 10);
    return Number.isFinite(major) ? major : undefined;
  } catch {
    return undefined;
  }
};

export function resolveWindowsPowerShell(options: ExecShellAdapterOptions = {}): string {
  const environment = options.environment ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const which = options.which ?? ((command) => Bun.which(command));
  const powerShellMajor = options.powerShellMajor ?? defaultPowerShellMajor;
  const programFiles = environment.ProgramFiles || environment.PROGRAMFILES || "C:\\Program Files";
  const programW6432 = environment.ProgramW6432 || "";
  const fixedPowerShell7 = [
    win32.join(programFiles, "PowerShell", "7", "pwsh.exe"),
    ...(programW6432 && programW6432 !== programFiles
      ? [win32.join(programW6432, "PowerShell", "7", "pwsh.exe")]
      : []),
  ];
  const pathPowerShell7 = which("pwsh") ?? which("pwsh.exe") ?? "";
  const powershell7 = [
    ...fixedPowerShell7.filter((candidate) => fileExists(candidate)),
    pathPowerShell7,
  ];
  for (const candidate of [...new Set(powershell7.filter(Boolean))]) {
    if ((powerShellMajor(candidate) ?? 0) >= 7) {
      return candidate;
    }
  }

  const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows";
  const windowsPowerShell = win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (fileExists(windowsPowerShell)) return windowsPowerShell;
  const fallback = which("powershell") ?? which("powershell.exe");
  if (fallback) return fallback;
  throw new Error("PowerShell is unavailable on this Windows host");
}

const powershellCommandBody = (executable: string, command: string): string => {
  const parts = ["try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}"];
  if (["pwsh", "pwsh.exe"].includes(win32.basename(executable).toLowerCase())) {
    parts.push("$PSStyle.OutputRendering = 'PlainText'");
  }
  if (command.trim()) parts.push(command.trim());
  parts.push([
    "$__lxe_success = $?;",
    "$__lxe_last_exit_code = $global:LASTEXITCODE;",
    "if (-not $__lxe_success) {",
    "if ($__lxe_last_exit_code -is [int] -and $__lxe_last_exit_code -ne 0) { exit $__lxe_last_exit_code };",
    "exit 1",
    "}",
  ].join(" "));
  return parts.join("\n");
};

const quotePowerShell = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const quotePosix = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const projectPythonPath = (root: string, platform: NodeJS.Platform): string => platform === "win32"
  ? win32.join(root, ".venv", "Scripts", "python.exe")
  : posix.join(root, ".venv", "bin", "python");

const projectBinPath = (root: string, platform: NodeJS.Platform): string => platform === "win32"
  ? win32.join(root, ".venv", "Scripts")
  : posix.join(root, ".venv", "bin");

const projectVenvPath = (root: string, platform: NodeJS.Platform): string => platform === "win32"
  ? win32.join(root, ".venv")
  : posix.join(root, ".venv");

const PROJECT_PYTHON_LAUNCHERS = new Set(["py", "python", "python.exe", "python3", "python3.exe"]);
const PROJECT_PIP_LAUNCHERS = new Set(["pip", "pip.exe", "pip3", "pip3.exe"]);
const PROJECT_PYTHON_VERSIONS = new Set(["-3", "-3.12", "-3.12.10"]);

export class ExecShellAdapter {
  readonly platform: NodeJS.Platform;
  private readonly environment: Environment;
  private readonly terminationGraceMs: number;
  private windowsPowerShell = "";

  constructor(private readonly options: ExecShellAdapterOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.terminationGraceMs = Math.max(1, Math.trunc(options.terminationGraceMs ?? 2_000));
  }

  lxeSkillArgv(root: string): string[] | undefined {
    const fileExists = this.options.fileExists ?? existsSync;
    const resourceRoot = String(
      this.environment.LXE_RESOURCE_ROOT ?? this.environment.LXE_ROOT ?? "",
    ).trim() || root;
    const python = String(this.environment.LXE_MANAGED_PYTHON ?? "").trim()
      || projectPythonPath(resourceRoot, this.platform);
    return fileExists(python) ? [python, "-I", "-m", "lxeskill"] : undefined;
  }

  normalizeCommand(root: string, rawCommand: string): string {
    const command = String(rawCommand ?? "").trim();
    if (!command) return "";
    if (/\b(?:services\.agent_cli|browser_auth_service\.main)\b/iu.test(command)) {
      throw new Error("registered business Python modules must be called through lxeskill");
    }
    const python = String(this.environment.LXE_MANAGED_PYTHON ?? "").trim()
      || projectPythonPath(root, this.platform);
    const fileExists = this.options.fileExists ?? existsSync;
    const quote = (value: string): string => this.platform === "win32" ? quotePowerShell(value) : quotePosix(value);
    const invokeExecutable = (value: string): string => `${this.platform === "win32" ? "& " : ""}${quote(value)}`;
    const managedUvPython = command.match(
      /^uv(?:\.exe)?\s+run\s+--frozen\s+python3?(?:\.exe)?(?=\s|$)([\s\S]*)$/iu,
    );
    if (managedUvPython && String(this.environment.LXE_MANAGED_PYTHON ?? "").trim()) {
      if (!fileExists(python)) throw new Error(`managed Python is unavailable: ${python}`);
      return `${invokeExecutable(python)}${String(managedUvPython[1] ?? "")}`;
    }
    const launcher = command.match(/^([A-Za-z0-9_.-]+)(?:\s+(-\d+(?:\.\d+){0,2}))?(?=\s|$)([\s\S]*)$/u);
    if (launcher) {
      const name = String(launcher[1] ?? "").toLowerCase();
      const version = String(launcher[2] ?? "");
      const rest = String(launcher[3] ?? "");
      if (PROJECT_PYTHON_LAUNCHERS.has(name)) {
        if (version && !PROJECT_PYTHON_VERSIONS.has(version)) {
          throw new Error(`project requires .venv Python 3.12.10; ${name} ${version} is not allowed`);
        }
        if (!fileExists(python)) throw new Error(`project Python is unavailable: ${python}`);
        return `${invokeExecutable(python)}${rest}`;
      }
      if (PROJECT_PIP_LAUNCHERS.has(name) && !version) {
        if (!fileExists(python)) throw new Error(`project Python is unavailable: ${python}`);
        return `${invokeExecutable(python)} -m pip${rest}`;
      }
    }
    const skill = command.match(/^lxeskill(?:\.cmd)?(?=\s|$)([\s\S]*)$/iu);
    if (skill) {
      const argv = this.lxeSkillArgv(root);
      if (!argv) {
        const managedPython = String(this.environment.LXE_MANAGED_PYTHON ?? "").trim();
        throw new Error(managedPython
          ? `managed Python is unavailable: ${managedPython}`
          : `project Python is unavailable: ${python}`);
      }
      const invocation = argv.map(quote).join(" ");
      return `${this.platform === "win32" ? "& " : ""}${invocation}${String(skill[1] ?? "")}`;
    }
    return command;
  }

  spawnSpec(command: string): ExecSpawnSpec {
    if (this.platform !== "win32") {
      return { argv: ["/bin/sh", "-c", command], detached: true };
    }
    this.windowsPowerShell ||= resolveWindowsPowerShell({ ...this.options, platform: this.platform });
    return {
      argv: [
        this.windowsPowerShell,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        powershellCommandBody(this.windowsPowerShell, command),
      ],
      detached: false,
    };
  }

  childEnvironment(root: string, context: ExecEnvironmentContext): Environment {
    const projectBin = projectBinPath(root, this.platform);
    const pathSeparator = this.platform === "win32" ? ";" : ":";
    const inheritedPath = this.environment.PATH ?? this.environment.Path ?? "";
    const managedPath = String(this.environment.LXE_MANAGED_PATH ?? "").trim();
    const pathEntries = (managedPath ? [managedPath, inheritedPath] : [projectBin, inheritedPath])
      .filter(Boolean);
    const resourceRoot = String(this.environment.LXE_RESOURCE_ROOT ?? "").trim() || root;
    const projectVenv = projectVenvPath(root, this.platform);
    return {
      ...this.environment,
      PATH: pathEntries.join(pathSeparator),
      ...(managedPath ? {} : { VIRTUAL_ENV: projectVenv }),
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      PYTHONNOUSERSITE: "1",
      LXE_ROOT: resourceRoot,
      LXE_RESOURCE_ROOT: resourceRoot,
      LXE_WORKSPACE_ROOT: root,
      LXE_AGENT_SESSION_ID: context.sessionId,
      LXE_RESPONSE_ROUTE_ID: context.responseRouteId,
      LXE_AGENT_TURN_ID: context.turnId,
      LXE_EXEC_SESSION_ID: context.execSessionId,
    };
  }

  async terminate(process_: SpawnedProcess, force: boolean): Promise<void> {
    if (this.platform === "win32") {
      const which = this.options.which ?? ((command: string) => Bun.which(command));
      const taskkill = which("taskkill") ?? which("taskkill.exe");
      if (taskkill) {
        const killer = Bun.spawn([taskkill, "/PID", String(process_.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        });
        await Promise.race([killer.exited.catch(() => undefined), Bun.sleep(this.terminationGraceMs)]);
      } else {
        try { process_.kill(); } catch { /* The process already exited. */ }
      }
      let exited = false;
      await Promise.race([
        process_.exited.then(() => { exited = true; }).catch(() => { exited = true; }),
        Bun.sleep(this.terminationGraceMs),
      ]);
      if (!exited) {
        try { process_.kill(); } catch { /* The process already exited. */ }
        await Promise.race([process_.exited.catch(() => undefined), Bun.sleep(this.terminationGraceMs)]);
      }
      return;
    }

    this.signalProcessGroup(process_.pid, force ? "SIGKILL" : "SIGTERM", process_);
    if (!force) {
      await Promise.race([process_.exited.catch(() => undefined), Bun.sleep(this.terminationGraceMs)]);
      if (this.processGroupAlive(process_.pid)) this.signalProcessGroup(process_.pid, "SIGKILL", process_);
    }
    await Promise.race([process_.exited.catch(() => undefined), Bun.sleep(this.terminationGraceMs)]);
  }

  private processGroupAlive(pid: number): boolean {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private signalProcessGroup(pid: number, signal: NodeJS.Signals, process_: SpawnedProcess): void {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      try { process_.kill(signal); } catch { /* The process already exited. */ }
    }
  }
}
