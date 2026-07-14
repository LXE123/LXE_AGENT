import type { BackgroundTaskPayload } from "../../api/payloads";

const TASK_STATUS_ORDER = ["running", "completed", "failed", "timeout", "killed"];

export function taskStatusRank(status: string): number {
  const index = TASK_STATUS_ORDER.indexOf(String(status || "").trim());
  return index >= 0 ? index : TASK_STATUS_ORDER.length;
}

export function groupTasksByStatus(tasks: BackgroundTaskPayload[]): Array<{ status: string; tasks: BackgroundTaskPayload[] }> {
  const groups = new Map<string, BackgroundTaskPayload[]>();
  for (const task of tasks) {
    const status = String(task.status || "unknown").trim() || "unknown";
    groups.set(status, [...(groups.get(status) || []), task]);
  }
  return Array.from(groups.entries())
    .map(([status, items]) => ({
      status,
      tasks: items.slice().sort((left, right) => right.started_at - left.started_at)
    }))
    .sort((left, right) => {
      const leftRank = taskStatusRank(left.status);
      const rightRank = taskStatusRank(right.status);
      return leftRank === rightRank ? left.status.localeCompare(right.status) : leftRank - rightRank;
    });
}

export function statusPillClass(status: string): string {
  const normalized = String(status || "").trim();
  if (normalized === "running" || normalized === "completed") {
    return "pill ok";
  }
  if (normalized === "failed" || normalized === "timeout" || normalized === "killed") {
    return "pill warn";
  }
  return "pill";
}
