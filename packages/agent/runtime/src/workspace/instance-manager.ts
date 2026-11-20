import { createHash } from "node:crypto";
import {
  existsSync,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createLogger, type Logger } from "@lxe/core";
import type { JsonObject, WorkspaceContext } from "@lxe/protocol";
import {
  SkillCatalog,
  type SkillCatalogSnapshot,
  type SkillPromptOptions,
} from "../tooling/skills";
import { WorkspaceSearchService } from "../tooling/workspace-search";

const DEFAULT_CHECK_INTERVAL_MS = 1_000;
const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_INSTANCES = 32;
const MAX_INSTRUCTION_FILE_BYTES = 256 * 1_024;
const MAX_INSTRUCTION_TOTAL_BYTES = 512 * 1_024;

export interface WorkspaceSnapshot {
  readonly generation: number;
  readonly loaded_at: number;
  readonly instructions_prompt: string;
  readonly skills: WorkspaceSkillSnapshot;
}

export type WorkspaceSkillSnapshot = SkillCatalogSnapshot;

export interface WorkspaceLease {
  readonly workspace: WorkspaceContext;
  readonly snapshot: WorkspaceSnapshot;
  readonly search: WorkspaceSearchService;
  release(): void;
}

export interface WorkspaceReloadResult extends JsonObject {
  changed: boolean;
  generation: number;
  loaded_at: number;
  instruction_count: number;
  skill_count: number;
}

export interface WorkspaceInstanceManagerOptions {
  skillCatalog: SkillCatalog;
  skillOptions?: () => SkillPromptOptions;
  checkIntervalMs?: number;
  debounceMs?: number;
  idleTtlMs?: number;
  sweepIntervalMs?: number;
  maxInstances?: number;
  now?: () => number;
  logger?: Logger;
  createSearch?: (worktree: string) => WorkspaceSearchService;
  watchPath?: (
    path: string,
    options: { recursive: boolean },
    listener: (filename: string) => void,
  ) => WorkspaceWatcher;
}

export interface WorkspaceWatcher {
  close(): void;
  unref?(): void;
}

interface InstructionDocument {
  source: string;
  scope: string;
  content: string;
}

interface WorkspaceView {
  workspace: WorkspaceContext;
  snapshot?: WorkspaceSnapshot;
  signature: string;
  instructionFingerprint: string;
  nextCheckAt: number;
  dirty: boolean;
  dirtyRevision: number;
  reload: Promise<WorkspaceReloadResult> | undefined;
}

interface WorkspaceInstance {
  key: string;
  worktree: string;
  search: WorkspaceSearchService;
  views: Map<string, WorkspaceView>;
  watchers: Map<string, WorkspaceWatcher>;
  activeLeases: number;
  lastUsedAt: number;
  disposePending: boolean;
}

const normalizedPathKey = (path: string): string => {
  let normalized = resolve(path);
  try { normalized = realpathSync(normalized); } catch { /* Availability is validated at the turn boundary. */ }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const workspaceKey = (workspace: WorkspaceContext): string =>
  normalizedPathKey(workspace.worktree);

const containsPath = (root: string, candidate: string): boolean => {
  const normalizedRoot = normalizedPathKey(root);
  const normalizedCandidate = normalizedPathKey(candidate);
  const relation = relative(normalizedRoot, normalizedCandidate);
  return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
};

const sha256 = (...parts: string[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
};

const cheapFileFingerprint = (path: string): string => {
  try {
    const info = statSync(path, { bigint: true });
    return `${path}:${realpathSync(path)}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${path}:missing`;
    throw error;
  }
};

const instructionDirectories = (workspace: WorkspaceContext): string[] => {
  const worktree = resolve(workspace.worktree);
  const directory = resolve(workspace.directory);
  if (!containsPath(worktree, directory)) {
    throw new Error(`workspace directory is outside its worktree: ${directory}`);
  }
  const relation = relative(worktree, directory);
  const directories = [worktree];
  if (!relation) return directories;
  let current = worktree;
  for (const part of relation.split(sep).filter(Boolean)) {
    current = join(current, part);
    directories.push(current);
  }
  return directories;
};

const instructionPaths = (workspace: WorkspaceContext): string[] =>
  instructionDirectories(workspace).map((directory) => join(directory, "AGENTS.md"));

const instructionFingerprint = (workspace: WorkspaceContext): string =>
  instructionPaths(workspace).map(cheapFileFingerprint).join("|");

const readUtf8File = async (path: string, maximumBytes: number, label: string): Promise<string> => {
  const real = realpathSync(path);
  const info = statSync(real);
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  if (info.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  const bytes = await readFile(real);
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8: ${path}`);
  }
};

const loadInstructions = async (workspace: WorkspaceContext): Promise<InstructionDocument[]> => {
  const documents: InstructionDocument[] = [];
  let totalBytes = 0;
  for (const path of instructionPaths(workspace)) {
    if (!existsSync(path)) continue;
    const real = realpathSync(path);
    if (!containsPath(workspace.worktree, real)) {
      throw new Error(`AGENTS.md escapes the Git worktree: ${path}`);
    }
    const info = statSync(real);
    if (!info.isFile()) throw new Error(`AGENTS.md is not a regular file: ${path}`);
    if (info.size > MAX_INSTRUCTION_FILE_BYTES) {
      throw new Error(`AGENTS.md exceeds ${MAX_INSTRUCTION_FILE_BYTES} bytes: ${path}`);
    }
    const rawContent = await readUtf8File(real, MAX_INSTRUCTION_FILE_BYTES, "AGENTS.md");
    totalBytes += Buffer.byteLength(rawContent, "utf8");
    if (totalBytes > MAX_INSTRUCTION_TOTAL_BYTES) {
      throw new Error(`workspace AGENTS.md files exceed ${MAX_INSTRUCTION_TOTAL_BYTES} bytes`);
    }
    const content = rawContent.trim();
    const scope = relative(workspace.worktree, dirname(path)).replaceAll("\\", "/") || ".";
    const source = relative(workspace.worktree, path).replaceAll("\\", "/");
    documents.push({ source, scope, content });
  }
  return documents;
};

const instructionsPrompt = (documents: readonly InstructionDocument[]): string => {
  if (documents.length === 0) return "";
  const sections = documents.map((document) => [
    `### ${document.source} (scope: ${document.scope})`,
    document.content || "(empty)",
  ].join("\n"));
  return [
    "## Workspace Instructions",
    "These instructions apply from the Git worktree root toward the working directory. Later, more specific files take precedence, but none may override system safety, tool permissions, or workspace boundaries.",
    "",
    ...sections,
  ].join("\n\n");
};

const skillSnapshotSignature = (snapshot: WorkspaceSkillSnapshot): string =>
  sha256(
    snapshot.prompt,
    JSON.stringify(snapshot.names),
    JSON.stringify(snapshot.modules),
    JSON.stringify(snapshot.locations ?? {}),
  );

export class WorkspaceInstanceManager {
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly instances = new Map<string, WorkspaceInstance>();
  private readonly checkIntervalMs: number;
  private readonly debounceMs: number;
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxInstances: number;
  private lastSkillRevision = 0;
  private generation = 0;
  private loadCount = 0;
  private reloadFailures = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: WorkspaceInstanceManagerOptions) {
    this.logger = options.logger ?? createLogger("runtime.workspace_instances");
    this.now = options.now ?? (() => Date.now());
    this.checkIntervalMs = Math.max(0, Math.trunc(options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS));
    this.debounceMs = Math.max(0, Math.trunc(options.debounceMs ?? DEFAULT_DEBOUNCE_MS));
    this.idleTtlMs = Math.max(0, Math.trunc(options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS));
    this.sweepIntervalMs = Math.max(0, Math.trunc(options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS));
    this.maxInstances = Math.max(1, Math.trunc(options.maxInstances ?? DEFAULT_MAX_INSTANCES));
  }

  async acquire(workspace: WorkspaceContext): Promise<WorkspaceLease> {
    this.ensureLifecycle();
    const instance = this.instanceFor(workspace);
    const view = this.viewFor(instance, workspace);
    let globalCheckFailed = false;
    try {
      await this.checkForChanges(view);
    } catch (error) {
      if (!view.snapshot) throw error;
      globalCheckFailed = true;
      this.reloadFailures += 1;
      this.logger.warn("workspace_global_reload_failed", {
        reason: "turn_acquire",
        worktree: workspace.worktree,
        directory: workspace.directory,
        error,
      });
    }
    if (!globalCheckFailed && (!view.snapshot || view.dirty)) {
      try {
        await this.reloadCurrentView(instance, view, false);
      } catch (error) {
        if (!view.snapshot) throw error;
        this.reloadFailures += 1;
        this.logger.warn("workspace_reload_failed", {
          reason: "turn_acquire",
          worktree: workspace.worktree,
          directory: workspace.directory,
          error,
        });
      }
    }
    if (!view.snapshot) throw new Error(`workspace snapshot is unavailable: ${workspace.directory}`);
    instance.activeLeases += 1;
    instance.lastUsedAt = this.now();
    const snapshot = view.snapshot;
    let released = false;
    return {
      workspace: { ...workspace },
      snapshot,
      search: instance.search,
      release: () => {
        if (released) return;
        released = true;
        instance.activeLeases = Math.max(0, instance.activeLeases - 1);
        instance.lastUsedAt = this.now();
        if (instance.disposePending && instance.activeLeases === 0) this.removeInstance(instance, "pending_dispose");
        this.evictOverflow();
      },
    };
  }

  async reload(workspace: WorkspaceContext, reason: string): Promise<WorkspaceReloadResult> {
    this.ensureLifecycle();
    const instance = this.instanceFor(workspace);
    const view = this.viewFor(instance, workspace);
    try {
      await this.options.skillCatalog.refreshForUse();
      this.refreshSkillRevision();
      return await this.reloadCurrentView(instance, view, true);
    } catch (error) {
      this.reloadFailures += 1;
      this.logger.warn("workspace_reload_failed", {
        reason,
        worktree: workspace.worktree,
        directory: workspace.directory,
        error,
      });
      throw error;
    }
  }

  async dispose(workspace: WorkspaceContext, reason: string): Promise<void> {
    const instance = this.instances.get(workspaceKey(workspace));
    if (!instance) return;
    if (instance.activeLeases > 0) {
      instance.disposePending = true;
      this.logger.debug("workspace_dispose_deferred", { reason, worktree: instance.worktree });
      return;
    }
    this.removeInstance(instance, reason);
  }

  async disposeAll(reason: string): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const instance of [...this.instances.values()]) this.removeInstance(instance, reason);
  }

  invalidate(reason: string): void {
    this.markAllDirty();
    this.logger.info("workspace_snapshots_invalidated", { reason });
  }

  diagnostics(): JsonObject {
    let dirty = 0;
    let reloading = 0;
    let activeLeases = 0;
    for (const instance of this.instances.values()) {
      activeLeases += instance.activeLeases;
      for (const view of instance.views.values()) {
        if (view.dirty) dirty += 1;
        if (view.reload) reloading += 1;
      }
    }
    return {
      instances: this.instances.size,
      views: [...this.instances.values()].reduce((total, instance) => total + instance.views.size, 0),
      dirty,
      reloading,
      active_leases: activeLeases,
      generation: this.generation,
      loads: this.loadCount,
      reload_failures: this.reloadFailures,
      max_instances: this.maxInstances,
    };
  }

  private ensureLifecycle(): void {
    if (!this.sweepTimer && this.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweepIdle(), this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  private instanceFor(workspace: WorkspaceContext): WorkspaceInstance {
    const key = workspaceKey(workspace);
    let instance = this.instances.get(key);
    if (instance) {
      this.instances.delete(key);
      this.instances.set(key, instance);
      instance.lastUsedAt = this.now();
      return instance;
    }
    instance = {
      key,
      worktree: workspace.worktree,
      search: this.options.createSearch?.(workspace.worktree) ?? new WorkspaceSearchService(workspace.worktree),
      views: new Map(),
      watchers: new Map(),
      activeLeases: 0,
      lastUsedAt: this.now(),
      disposePending: false,
    };
    this.instances.set(key, instance);
    this.evictOverflow(instance);
    this.logger.info("workspace_instance_created", { worktree: workspace.worktree });
    return instance;
  }

  private viewFor(instance: WorkspaceInstance, workspace: WorkspaceContext): WorkspaceView {
    const key = normalizedPathKey(workspace.directory);
    let view = instance.views.get(key);
    if (!view) {
      view = {
        workspace: { ...workspace },
        signature: "",
        instructionFingerprint: "",
        nextCheckAt: 0,
        dirty: true,
        dirtyRevision: 1,
        reload: undefined,
      };
      instance.views.set(key, view);
      this.watchInstructionDirectories(instance, workspace);
    }
    return view;
  }

  private async checkForChanges(view: WorkspaceView): Promise<void> {
    await this.options.skillCatalog.refreshForUse();
    this.refreshSkillRevision();
    const now = this.now();
    if (view.snapshot && now < view.nextCheckAt) return;
    const fingerprint = instructionFingerprint(view.workspace);
    if (view.instructionFingerprint && view.instructionFingerprint !== fingerprint) {
      view.dirty = true;
      view.dirtyRevision += 1;
    }
    view.nextCheckAt = now + this.checkIntervalMs;
  }

  private refreshSkillRevision(): void {
    // Skill discovery belongs to turn acquisition and explicit reload, never watcher callbacks.
    const revision = this.options.skillCatalog.revision();
    if (revision !== this.lastSkillRevision) {
      this.lastSkillRevision = revision;
      this.markAllDirty();
    }
  }

  private reloadView(
    instance: WorkspaceInstance,
    view: WorkspaceView,
    forceInstructions: boolean,
  ): Promise<WorkspaceReloadResult> {
    if (view.reload) return view.reload;
    const dirtyRevision = view.dirtyRevision;
    const operation = (async (): Promise<WorkspaceReloadResult> => {
      const documents = await loadInstructions(view.workspace);
      const fingerprint = instructionFingerprint(view.workspace);
      const prompt = instructionsPrompt(documents);
      const skills = this.options.skillCatalog.snapshot(
        this.options.skillOptions?.() ?? {},
        view.workspace,
      );
      const signature = sha256(prompt, skillSnapshotSignature(skills));
      const changed = !view.snapshot || signature !== view.signature;
      view.instructionFingerprint = fingerprint;
      view.dirty = view.dirtyRevision !== dirtyRevision;
      if (changed) {
        this.generation += 1;
        this.loadCount += 1;
        view.signature = signature;
        view.snapshot = Object.freeze({
          generation: this.generation,
          loaded_at: Math.trunc(Date.now() / 1_000),
          instructions_prompt: prompt,
          skills,
        });
        this.logger.info("workspace_snapshot_loaded", {
          worktree: view.workspace.worktree,
          directory: view.workspace.directory,
          generation: this.generation,
          instruction_count: documents.length,
          skill_count: skills.names.length,
          forced: forceInstructions,
        });
      }
      const snapshot = view.snapshot!;
      return {
        changed,
        generation: snapshot.generation,
        loaded_at: snapshot.loaded_at,
        instruction_count: documents.length,
        skill_count: skills.names.length,
      };
    })();
    view.reload = operation.finally(() => { view.reload = undefined; });
    return view.reload;
  }

  private async reloadCurrentView(
    instance: WorkspaceInstance,
    view: WorkspaceView,
    forced: boolean,
  ): Promise<WorkspaceReloadResult> {
    const initial = await this.reloadView(instance, view, forced);
    if (!view.dirty) return initial;
    const final = await this.reloadView(instance, view, forced);
    return { ...final, changed: initial.changed || final.changed };
  }

  private markAllDirty(): void {
    for (const instance of this.instances.values()) {
      for (const view of instance.views.values()) {
        view.dirty = true;
        view.dirtyRevision += 1;
      }
    }
  }

  private markDirtyAndSchedule(reason: string): void {
    this.markAllDirty();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.reloadDirty(reason);
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private async reloadDirty(reason: string): Promise<void> {
    this.refreshSkillRevision();
    const reloads: Promise<WorkspaceReloadResult>[] = [];
    for (const instance of this.instances.values()) {
      for (const view of instance.views.values()) {
        if (view.dirty) reloads.push(this.reloadView(instance, view, true));
      }
    }
    const results = await Promise.allSettled(reloads);
    for (const result of results) {
      if (result.status === "rejected") {
        this.reloadFailures += 1;
        this.logger.warn("workspace_reload_failed", { reason, error: result.reason });
      }
    }
  }

  private watchInstructionDirectories(instance: WorkspaceInstance, workspace: WorkspaceContext): void {
    for (const directory of instructionDirectories(workspace)) {
      const key = normalizedPathKey(directory);
      if (instance.watchers.has(key)) continue;
      try {
        const watcher = this.watchPath(directory, false, (filename) => {
          const name = filename;
          if (!name || basename(name).toLowerCase() === "agents.md") {
            this.markDirtyAndSchedule("workspace_instructions_watch");
          }
        });
        watcher.unref?.();
        instance.watchers.set(key, watcher);
      } catch (error) {
        this.logger.debug("workspace_instruction_watch_unavailable", { directory, error });
      }
    }
  }

  private sweepIdle(): void {
    if (this.idleTtlMs <= 0) return;
    const cutoff = this.now() - this.idleTtlMs;
    for (const instance of [...this.instances.values()]) {
      if (instance.activeLeases === 0 && instance.lastUsedAt <= cutoff) {
        this.removeInstance(instance, "idle_ttl");
      }
    }
  }

  private watchPath(path: string, recursive: boolean, listener: (filename: string) => void): WorkspaceWatcher {
    if (this.options.watchPath) return this.options.watchPath(path, { recursive }, listener);
    return watch(path, { recursive }, (_event, filename) => listener(filename?.toString() ?? ""));
  }

  private evictOverflow(protectedInstance?: WorkspaceInstance): void {
    this.sweepIdle();
    while (this.instances.size > this.maxInstances) {
      const candidate = [...this.instances.values()].find((instance) =>
        instance !== protectedInstance && instance.activeLeases === 0);
      if (!candidate) return;
      this.removeInstance(candidate, "lru_capacity");
    }
  }

  private removeInstance(instance: WorkspaceInstance, reason: string): void {
    if (instance.activeLeases > 0) {
      instance.disposePending = true;
      return;
    }
    for (const watcher of instance.watchers.values()) watcher.close();
    instance.watchers.clear();
    instance.views.clear();
    this.instances.delete(instance.key);
    this.logger.info("workspace_instance_disposed", { reason, worktree: instance.worktree });
  }
}
