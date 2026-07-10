import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RUNTIME_WORKER_COMMAND,
  spawnManagedProcessTree,
  spawnRuntimeWorker,
} from "./worker-process";
import { WorkerClient } from "./worker-client";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const withTimeout = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const pidExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readLine = async (stream: ReadableStream<Uint8Array>, milliseconds: number): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    return await withTimeout((async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("stdout closed before a line was written");
        buffer += decoder.decode(value, { stream: true });
        const newline = buffer.indexOf("\n");
        if (newline >= 0) return buffer.slice(0, newline);
      }
    })(), milliseconds);
  } finally {
    reader.releaseLock();
  }
};

const waitForPidsGone = async (pids: number[], milliseconds: number): Promise<void> => {
  const deadline = Date.now() + milliseconds;
  while (pids.some(pidExists) && Date.now() < deadline) await Bun.sleep(20);
  const survivors = pids.filter(pidExists);
  if (survivors.length > 0) throw new Error(`orphan processes survived: ${survivors.join(",")}`);
};

describe("runtime worker process adapter", () => {
  test("uses the exact frozen uv command without a shell", () => {
    expect(RUNTIME_WORKER_COMMAND).toEqual([
      "uv",
      "run",
      "--frozen",
      "python",
      "-m",
      "agent_runtime.worker",
    ]);
  });

  test("handshakes, reports health, and exits without an orphan child", async () => {
    const projectRoot = resolve(import.meta.dir, "../../..");
    const temporary = await mkdtemp(join(tmpdir(), "lxe worker 中文 "));
    temporaryPaths.push(temporary);
    const worker = spawnRuntimeWorker({
      projectRoot,
      env: {
        ...process.env,
        LXE_SQLITE_DB_PATH: join(temporary, "runtime.sqlite3"),
        LOCAL_LOGS_ENABLED: "0",
      },
    });
    const fatals: Error[] = [];
    const client = new WorkerClient({ process: worker, onFatal: (error) => fatals.push(error) });
    client.start();

    let workerPid = 0;
    try {
      const hello = await withTimeout(client.request("worker.hello", {}), 10_000);
      workerPid = Number(hello.worker_pid);
      expect(hello.protocol_version).toBe("1");
      expect(workerPid).toBeGreaterThan(0);
      const health = await withTimeout(client.request("health", {}), 5_000);
      expect(health.ready).toBe(true);

      const shutdown = client.request("worker.shutdown", {});
      await client.flushWrites();
      expect((await withTimeout(shutdown, 5_000)).shutting_down).toBe(true);
      client.closeStdin();
      expect(await withTimeout(worker.exited, 5_000)).toBe(0);
    } finally {
      if (pidExists(worker.pid)) await worker.forceKill();
      await withTimeout(worker.exited, 5_000).catch(() => undefined);
    }

    expect(fatals).toEqual([]);
    expect(pidExists(worker.pid)).toBe(false);
    expect(pidExists(workerPid)).toBe(false);
  }, 20_000);

  test("force-kills the full POSIX process group including a stubborn grandchild", async () => {
    if (process.platform === "win32") return;
    const projectRoot = resolve(import.meta.dir, "../../..");
    const code = [
      "import json,os,subprocess,sys,time",
      "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])",
      "print(json.dumps({'parent':os.getpid(),'child':child.pid}),flush=True)",
      "time.sleep(60)",
    ].join(";");
    const tree = spawnManagedProcessTree({
      cmd: ["uv", "run", "--frozen", "python", "-c", code],
      cwd: projectRoot,
      env: process.env,
    });
    let descendants: { parent: number; child: number } | undefined;
    try {
      descendants = JSON.parse(await readLine(tree.stdout, 10_000)) as {
        parent: number;
        child: number;
      };
      expect(pidExists(tree.pid)).toBe(true);
      expect(pidExists(descendants.parent)).toBe(true);
      expect(pidExists(descendants.child)).toBe(true);
      await tree.forceKill();
      await withTimeout(tree.exited, 5_000);
      await waitForPidsGone([tree.pid, descendants.parent, descendants.child], 5_000);
    } finally {
      if (pidExists(tree.pid)) await tree.forceKill();
      if (descendants) {
        for (const pid of [descendants.parent, descendants.child]) {
          if (pidExists(pid)) process.kill(pid, "SIGKILL");
        }
      }
    }
  }, 20_000);
});
