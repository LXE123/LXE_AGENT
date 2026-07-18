import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

/** Stable desktop/runtime identity shared by every local process. */
export interface MachineIdentity {
  machine_id: string;
  hostname_at_creation: string;
  created_at: string;
}

const readIdentity = (path: string): MachineIdentity => {
  const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const machineId = String(payload.machine_id ?? "").trim();
  if (!machineId) throw new Error(`Machine identity is missing machine_id: ${path}`);
  return {
    machine_id: machineId,
    hostname_at_creation: String(payload.hostname_at_creation ?? "").trim(),
    created_at: String(payload.created_at ?? "").trim(),
  };
};

export function resolveMachineIdentity(path: string): MachineIdentity {
  if (existsSync(path)) return readIdentity(path);
  const identity: MachineIdentity = {
    machine_id: randomUUID().replaceAll("-", ""),
    hostname_at_creation: hostname(),
    created_at: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    linkSync(temporary, path);
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readIdentity(path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
