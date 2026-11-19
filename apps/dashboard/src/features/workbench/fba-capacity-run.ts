import type { SessionRunPhase } from "@lxe/protocol/session-status";

/** Team skill this page drives; it is installed from the team skills catalog. */
export const FBA_CAPACITY_SKILL = "amazon-fba-capacity-report";

/** Stores offered on the page. The session matches these names against the live Ziniao list. */
export const FBA_CAPACITY_STORES = [
  "Amazon-XIUTAI-US",
  "Amazon-YYH-US",
  "Amazon-YRZ-US",
  "Amazon-HSP-US",
  "Amazon-LEIXIUER-US",
  "Amazon-Yunjian-US",
  "Amazon-Liansheng-US",
] as const;

/** The skill's default eight sites, in its collection order. */
export const FBA_CAPACITY_SITES = ["US", "CA", "SA", "AE", "UK", "DE", "AU", "JP"] as const;
export type FbaCapacitySite = typeof FBA_CAPACITY_SITES[number];

const OUTPUT_ROOT = "FBA库容报告";
const RUNS_KEY = "lxe.workbench.fba-capacity.runs.v1";
const SELECTION_KEY = "lxe.workbench.fba-capacity.selection.v1";
const FULL_ACCESS_KEY = "lxe.workbench.fba-capacity.full-access.v1";
const MAX_RUNS = 10;

export interface FbaCapacityRun {
  id: string;
  created_at: number;
  stores: string[];
  sites: FbaCapacitySite[];
  session_id: string;
  turn_id: string;
  /** Workspace-relative folder for the workbooks. */
  output: string;
  /**
   * Absolute workspace path, read from the session right after sending. Kept so the folder can still be
   * found once the conversation is deleted; runs recorded before this field existed do not have it.
   */
  directory?: string;
  /** The session was set to Full access before the task was sent. */
  full_access?: boolean;
}

export interface FbaCapacitySelection { stores: string[]; sites: FbaCapacitySite[] }

export type FbaCapacityRunState =
  | "queued" | "running" | "waiting_input" | "waiting_approval" | "stopping"
  | "completed" | "error" | "cancelled" | "unknown" | "missing";

const pad = (value: number) => String(value).padStart(2, "0");

/** One new folder per run, named by local start time so colleagues can find it in the workspace. */
export function outputFolder(now: Date): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${OUTPUT_ROOT}/${stamp}`;
}

/** Keeps the order the page lists, so prompts and history read the same way every time. */
export function orderedSelection(selection: FbaCapacitySelection): FbaCapacitySelection {
  return {
    stores: FBA_CAPACITY_STORES.filter(store => selection.stores.includes(store)),
    sites: FBA_CAPACITY_SITES.filter(site => selection.sites.includes(site)),
  };
}

export function capacityPrompt(selection: FbaCapacitySelection, output: string): string {
  const { stores, sites } = orderedSelection(selection);
  if (stores.length === 0) throw new Error("至少选择一个店铺");
  if (sites.length === 0) throw new Error("至少选择一个站点");
  const allSites = sites.length === FBA_CAPACITY_SITES.length;
  return [
    `/${FBA_CAPACITY_SKILL}`,
    "",
    "请为以下店铺采集 FBA 库容截图并生成报告。",
    "",
    "店铺（按顺序逐个处理，同一时间只操作一个店铺）：",
    ...stores.map(store => `- ${store}`),
    "",
    `站点：${allSites ? "默认八站" : sites.join(" ")}`,
    "",
    `产出目录：当前工作区下的 \`${output}\`（不存在就创建）。每个店铺的 Excel 报告都保存到这里；采集过程的中间文件按技能要求处理。`,
    "",
    "某个店铺失败时继续处理其他店铺。全部处理完后在回复里简要说明：每个店铺使用率严格大于 90% 的站点，以及缺项、失败的站点和实际原因。",
  ].join("\n");
}

/** Turn status plus pending questions or approvals, as the page shows it. */
export function runState(phase: SessionRunPhase | "missing", waiting: { question: boolean; approval: boolean }): FbaCapacityRunState {
  if (phase !== "running") return phase;
  return waiting.question ? "waiting_input" : waiting.approval ? "waiting_approval" : "running";
}

export const settled = (state: FbaCapacityRunState): boolean =>
  state === "completed" || state === "error" || state === "cancelled" || state === "missing";

/**
 * A deleted conversation answers `sessions.detail` with "session not found". The RPC code does not
 * survive the IPC hop, so the runtime's message is the signal; anything else is a real error.
 */
export const conversationDeleted = (error: unknown): boolean =>
  /\bsession not found\b/i.test(error instanceof Error ? error.message : String(error));

/** Excel workbooks in the output folder, without Excel's `~$` lock files. */
export function resultFiles(entries: Array<{ name: string; path: string; kind: string }>): Array<{ name: string; path: string }> {
  return entries
    .filter(entry => entry.kind === "file" && /\.xlsx$/i.test(entry.name) && !entry.name.startsWith("~$"))
    .map(({ name, path }) => ({ name, path }));
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const browserStorage = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

function readJson(key: string, storage: Storage | null): unknown {
  try { const raw = storage?.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeJson(key: string, value: unknown, storage: Storage | null): void {
  try { storage?.setItem(key, JSON.stringify(value)); } catch { /* History is a convenience; the sessions keep the real record. */ }
}

const textList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const siteList = (value: unknown): FbaCapacitySite[] => textList(value).filter((item): item is FbaCapacitySite => (FBA_CAPACITY_SITES as readonly string[]).includes(item));

function validRun(value: unknown): FbaCapacityRun | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  const text = (key: string) => typeof run[key] === "string" && run[key] ? run[key] as string : null;
  const id = text("id"), session = text("session_id"), turn = text("turn_id"), output = text("output");
  if (!id || !session || !turn || !output || typeof run.created_at !== "number") return null;
  return { id, created_at: run.created_at, stores: textList(run.stores), sites: siteList(run.sites), session_id: session, turn_id: turn, output,
    ...(run.full_access === true ? { full_access: true } : {}), ...(text("directory") ? { directory: text("directory")! } : {}) };
}

/** Absolute output folder, joined with the separator the workspace path already uses. */
export function runFolder(run: Pick<FbaCapacityRun, "directory" | "output">): string | null {
  if (!run.directory) return null;
  const windows = run.directory.includes("\\") && !run.directory.includes("/");
  const base = run.directory.replace(/[\\/]+$/, "");
  return windows ? `${base}\\${run.output.replaceAll("/", "\\")}` : `${base}/${run.output}`;
}

/** Newest first. Stored per machine; losing it only hides the shortcut, the conversations remain. */
export function loadRuns(storage: Storage | null = browserStorage()): FbaCapacityRun[] {
  const value = readJson(RUNS_KEY, storage);
  return Array.isArray(value) ? value.map(validRun).filter((run): run is FbaCapacityRun => run !== null) : [];
}

/** Drops one run from this page's history; the conversation and its files are left alone. */
export function forgetRun(id: string, storage: Storage | null = browserStorage()): FbaCapacityRun[] {
  const runs = loadRuns(storage).filter(run => run.id !== id);
  writeJson(RUNS_KEY, runs, storage);
  return runs;
}

export function recordRun(run: FbaCapacityRun, storage: Storage | null = browserStorage()): FbaCapacityRun[] {
  const runs = [run, ...loadRuns(storage).filter(item => item.id !== run.id)].slice(0, MAX_RUNS);
  writeJson(RUNS_KEY, runs, storage);
  return runs;
}

/** Last choice, or no stores and all eight sites on first use. */
export function loadSelection(storage: Storage | null = browserStorage()): FbaCapacitySelection {
  const value = readJson(SELECTION_KEY, storage) as Record<string, unknown> | null;
  const stores = textList(value?.stores).filter(store => (FBA_CAPACITY_STORES as readonly string[]).includes(store));
  const sites = siteList(value?.sites);
  return { stores, sites: sites.length ? sites : [...FBA_CAPACITY_SITES] };
}

export function saveSelection(selection: FbaCapacitySelection, storage: Storage | null = browserStorage()): void {
  writeJson(SELECTION_KEY, orderedSelection(selection), storage);
}

/** Off unless the person confirmed Full access on this device. */
export function loadFullAccess(storage: Storage | null = browserStorage()): boolean {
  return readJson(FULL_ACCESS_KEY, storage) === true;
}

export function saveFullAccess(value: boolean, storage: Storage | null = browserStorage()): void {
  writeJson(FULL_ACCESS_KEY, value, storage);
}
