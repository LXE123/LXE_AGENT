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

  recordCurrent(sessionId: string, path: string): void {
    const version = currentFileVersion(path);
    if (version !== undefined) this.recordVersion(sessionId, path, version);
  }

  assertCurrent(sessionId: string, path: string, action: string): void {
    const key = `${sessionId}\0${path}`;
    const recorded = this.entries.get(key);
    if (recorded === undefined) throw new Error(`${action} 被拒绝：请先用 read 读取该文件再修改: ${path}`);
    const current = currentFileVersion(path);
    if (current !== recorded) {
      throw new Error(`${action} 被拒绝：文件在上次 read 之后被修改过，请重新 read 确认最新内容: ${path}`);
    }
  }
}
