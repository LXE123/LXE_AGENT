import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { JsonObject } from "@lxe/protocol";

export const DEFAULT_MARKER_TTL_SECONDS = 300;

export interface GatewayStatus extends JsonObject {
  pid: number;
  boot_id: string;
  started_at: string;
  marker_path: string;
}

export interface PlannedStopMarker extends JsonObject {
  target_pid: number;
  target_boot_id: string;
  requester_pid: number;
  requested_at: string;
}

export interface GatewayStatusFilesOptions {
  projectRoot: string;
  pid?: number;
  requesterPid?: number;
  now?: () => Date;
  markerTtlSeconds?: number;
}

const safeInteger = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^[-+]?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return 0;
};

const readObject = (path: string): JsonObject | undefined => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
};

const remove = (path: string): void => {
  rmSync(path, { force: true });
};

const parseTimestamp = (value: unknown): number | undefined => {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export class GatewayStatusFiles {
  readonly runtimeDir: string;
  readonly statusPath: string;
  readonly markerPath: string;
  private readonly pid: number;
  private readonly requesterPid: number;
  private readonly now: () => Date;
  private readonly markerTtlSeconds: number;
  private writeCounter = 0;

  constructor(options: GatewayStatusFilesOptions) {
    this.runtimeDir = join(options.projectRoot, "var", "tmp", "gateway");
    this.statusPath = join(this.runtimeDir, "gateway-status.json");
    this.markerPath = join(this.runtimeDir, "gateway-planned-stop.json");
    this.pid = Math.trunc(options.pid ?? process.pid);
    this.requesterPid = Math.trunc(options.requesterPid ?? process.pid);
    this.now = options.now ?? (() => new Date());
    this.markerTtlSeconds = Math.max(1, Number(options.markerTtlSeconds ?? DEFAULT_MARKER_TTL_SECONDS));
  }

  writeStatus(bootId: string): GatewayStatus {
    const safeBootId = String(bootId ?? "").trim();
    if (!safeBootId) throw new Error("boot_id required");
    const status: GatewayStatus = {
      pid: this.pid,
      boot_id: safeBootId,
      started_at: this.now().toISOString(),
      marker_path: this.markerPath,
    };
    this.atomicWrite(this.statusPath, status);
    return status;
  }

  readStatus(): GatewayStatus | undefined {
    return readObject(this.statusPath) as GatewayStatus | undefined;
  }

  clearStatus(bootId: string): void {
    const status = this.readStatus();
    if (!status || String(status.boot_id ?? "") !== String(bootId ?? "")) return;
    remove(this.statusPath);
  }

  writePlannedStopMarker(status: GatewayStatus): PlannedStopMarker {
    const targetPid = safeInteger(status.pid);
    const targetBootId = String(status.boot_id ?? "").trim();
    if (targetPid <= 0) throw new Error("gateway status is missing a valid pid");
    if (!targetBootId) throw new Error("gateway status is missing a boot_id");
    const marker: PlannedStopMarker = {
      target_pid: targetPid,
      target_boot_id: targetBootId,
      requester_pid: this.requesterPid,
      requested_at: this.now().toISOString(),
    };
    this.atomicWrite(this.markerPath, marker);
    return marker;
  }

  readMarker(): PlannedStopMarker | undefined {
    return readObject(this.markerPath) as PlannedStopMarker | undefined;
  }

  markerTargetsSelf(bootId: string): boolean {
    const marker = this.readMarker();
    if (!marker || this.markerAgeSeconds(marker) === undefined) return false;
    if (this.markerAgeSeconds(marker)! > this.markerTtlSeconds) return false;
    return (
      safeInteger(marker.target_pid) === this.pid &&
      String(marker.target_boot_id ?? "") === String(bootId ?? "")
    );
  }

  consumeMarkerForSelf(bootId: string): boolean {
    const marker = this.readMarker();
    if (!marker) return false;
    const age = this.markerAgeSeconds(marker);
    if (age === undefined || age > this.markerTtlSeconds) {
      remove(this.markerPath);
      return false;
    }
    const matches =
      safeInteger(marker.target_pid) === this.pid &&
      String(marker.target_boot_id ?? "") === String(bootId ?? "");
    remove(this.markerPath);
    return matches;
  }

  private markerAgeSeconds(marker: PlannedStopMarker): number | undefined {
    const requestedAt = parseTimestamp(marker.requested_at);
    if (requestedAt === undefined) return undefined;
    return Math.max(0, this.now().getTime() - requestedAt) / 1_000;
  }

  private atomicWrite(path: string, payload: JsonObject): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${this.pid}-${this.writeCounter++}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(temporary, path);
    } finally {
      remove(temporary);
    }
  }
}

export interface PollerClock {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(token: unknown): void;
}

const defaultPollerClock: PollerClock = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (token) => clearInterval(token as ReturnType<typeof setInterval>),
};

export class PlannedStopPoller {
  private token: unknown;
  private requested = false;

  constructor(
    private readonly files: GatewayStatusFiles,
    private readonly clock: PollerClock = defaultPollerClock,
    private readonly onError: (error: Error) => void = () => undefined,
  ) {}

  start(bootId: string, requestStop: () => void, pollIntervalMs = 500): void {
    this.stop();
    this.requested = false;
    this.token = this.clock.setInterval(() => {
      try {
        if (this.requested || !this.files.consumeMarkerForSelf(bootId)) return;
        requestStop();
        this.requested = true;
        this.stop();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        try {
          this.onError(error);
        } catch {
          // Logging failure must not stop future planned-stop polls.
        }
      }
    }, Math.max(50, Math.trunc(pollIntervalMs)));
  }

  stop(): void {
    if (this.token === undefined) return;
    this.clock.clearInterval(this.token);
    this.token = undefined;
  }
}

export class GatewayStatusController {
  constructor(
    readonly files: GatewayStatusFiles,
    private readonly poller: PlannedStopPoller = new PlannedStopPoller(files),
  ) {}

  writeStatus(bootId: string): GatewayStatus {
    return this.files.writeStatus(bootId);
  }

  clearStatus(bootId: string): void {
    this.files.clearStatus(bootId);
  }

  startPolling(bootId: string, requestStop: () => void): void {
    this.poller.start(bootId, requestStop);
  }

  stopPolling(): void {
    this.poller.stop();
  }
}
