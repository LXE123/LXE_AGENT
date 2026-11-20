import type { Automation, AutomationRun } from "@lxe/desktop-protocol";

export interface AutomationStore {
  list(includeDeleted?: boolean): Automation[];
  get(id: string): Automation | undefined;
  save(task: Automation, expectedVersion: number | null): void;
  /** Atomically records dispatch intent and consumes the scheduled opportunity. */
  claim(previous: Automation, next: Automation, run: AutomationRun): boolean;
  saveRun(run: AutomationRun): void;
  runs(id?: string, limit?: number): AutomationRun[];
  setting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}
