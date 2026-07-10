import type { WorkerProcess } from "./worker-client";

export const RUNTIME_WORKER_COMMAND = [
  "uv",
  "run",
  "--frozen",
  "python",
  "-m",
  "agent_runtime.worker",
] as const;

export interface SpawnRuntimeWorkerOptions {
  projectRoot: string;
  env?: Record<string, string | undefined>;
}

export interface SpawnManagedProcessTreeOptions {
  cmd: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}

export function spawnManagedProcessTree(options: SpawnManagedProcessTreeOptions): WorkerProcess {
  const subprocess = Bun.spawn({
    cmd: options.cmd,
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    // On POSIX this calls setsid(), making the direct child the process-group
    // leader so a negative PID signal reaches uv, Python, and grandchildren.
    detached: process.platform !== "win32",
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    pid: subprocess.pid,
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
    exited: subprocess.exited,
    async writeStdin(data: Uint8Array): Promise<void> {
      subprocess.stdin.write(data);
      await subprocess.stdin.flush();
    },
    closeStdin(): void {
      subprocess.stdin.end();
    },
    kill(): void {
      if (process.platform === "win32") {
        subprocess.kill(15);
        return;
      }
      try {
        process.kill(-subprocess.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
    async forceKill(): Promise<void> {
      if (process.platform === "win32") {
        const taskkill = Bun.spawn({
          cmd: ["taskkill", "/PID", String(subprocess.pid), "/T", "/F"],
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        await taskkill.exited;
        await subprocess.exited;
        return;
      }
      try {
        process.kill(-subprocess.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await subprocess.exited;
    },
  };
}

export function spawnRuntimeWorker(options: SpawnRuntimeWorkerOptions): WorkerProcess {
  return spawnManagedProcessTree({
    cmd: [...RUNTIME_WORKER_COMMAND],
    cwd: options.projectRoot,
    env: {
      ...process.env,
      ...options.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
    },
  });
}

export const createRuntimeWorkerSpawner = (
  options: SpawnRuntimeWorkerOptions,
): (() => WorkerProcess) => () => spawnRuntimeWorker(options);
