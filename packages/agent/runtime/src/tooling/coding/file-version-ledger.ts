import { statSync } from "node:fs";

export type FileVersion = string;

export const fileVersionFromStats = (
  info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
): FileVersion => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;

export const currentFileVersion = (path: string): FileVersion | undefined => {
  try {
    return fileVersionFromStats(statSync(path, { bigint: true }));
  } catch {
    return undefined;
  }
};

export class FileVersionLedger {
  private readonly entries = new Map<string, FileVersion>();

  constructor(private readonly maximum = 10_000) {}

  recordVersion(sessionId: string, path: string, version: FileVersion): void {
    const key = `${sessionId}\0${path}`;
    this.entries.delete(key);
    this.entries.set(key, version);
    while (this.entries.size > this.maximum) this.entries.delete(this.entries.keys().next().value!);
  }

  recordCurrent(sessionId: string, path: string, actualPath = path): void {
    const version = currentFileVersion(actualPath);
    if (version !== undefined) this.recordVersion(sessionId, path, version);
  }

  assertVersion(sessionId: string, path: string, action: string, current: FileVersion | undefined): void {
    const key = `${sessionId}\0${path}`;
    const recorded = this.entries.get(key);
    if (recorded === undefined) throw new Error(`${action} rejected. Use read before modifying this file: ${path}`);
    // Compare the caller's fresh observation without another filesystem read.
    // The ledger key remains the read spelling, even when writes use a real path.
    if (current !== recorded) {
      throw new Error(`${action} rejected. The file changed since the last read. Read it again before modifying it: ${path}`);
    }
  }
}
