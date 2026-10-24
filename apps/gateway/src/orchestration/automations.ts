import { randomUUID } from "node:crypto";
import { sanitizeLogValueWithPolicy } from "@lxe/core";
import { parseAutomationDefinition, type Automation, type AutomationDefinition, type AutomationRun, type AutomationRunView } from "@lxe/desktop-protocol";
import type { AutomationStore } from "./automation-store";
import { validateAutomationTime } from "./automation-time";
import { AutomationClock } from "./automation-clock";

export class AutomationBlockedError extends Error {}
export class AutomationTargetMissingError extends Error {}

export interface AutomationExecutionPort {
  ready(): boolean;
  validate(definition: AutomationDefinition): Promise<void>;
  blockReason(task: Automation): Promise<string | null>;
  submit(run: AutomationRun, assertCurrent: () => void): Promise<void>;
  observe(run: AutomationRun): Promise<AutomationRunView["execution_state"] | "missing">;
}

const diagnostic = (error: unknown): string => String(sanitizeLogValueWithPolicy(
  error instanceof Error ? error.message : String(error), { maxString: 4000 },
));

export class AutomationService {
  private readonly clock: AutomationClock;
  private readonly now: () => number;
  private readonly salt: string;
  private timer?: ReturnType<typeof setInterval>;
  private ticking: Promise<void> | undefined;
  private stopped = true;
  private recovered = false;
  private readonly dispatching = new Set<string>();
  private readonly pendingDispatches = new Set<Promise<AutomationRun>>();
  private readonly editing = new Map<string, number>();
  constructor(private readonly options: {
    store: AutomationStore; execution: AutomationExecutionPort; now?: () => number;
    clock?: AutomationClock; changed?: () => void; onError?: (error: unknown) => void;
  }) {
    this.clock = options.clock ?? new AutomationClock();
    this.now = options.now ?? Date.now;
    this.salt = options.store.setting("jitter_salt") ?? randomUUID();
    options.store.setSetting("jitter_salt", this.salt);
  }
  list(): Automation[] { return this.options.store.list().sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id)); }
  get(id: string): Automation {
    const task = this.options.store.get(id);
    if (!task || task.status === "deleted") throw new Error(`Task not found: ${id}`);
    return task;
  }
  private changed(): void { this.options.changed?.(); }
  private matching(id: string, version: number): Automation {
    const task = this.get(id);
    if (task.version !== version) throw new Error("Task changed; refresh before editing");
    return task;
  }
  async save(input: { definition: AutomationDefinition; id?: string; version?: number }, assertCurrent?: () => void): Promise<Automation> {
    const definition = parseAutomationDefinition(input.definition);
    validateAutomationTime(definition);
    if (definition.schedule.kind === "once" && definition.schedule.at <= this.now()) throw new Error("一次性任务请选择未来的时间");
    await this.options.execution.validate(definition);
    assertCurrent?.();
    let previous = input.id ? this.matching(input.id, input.version!) : undefined;
    const now = this.now(), id = previous?.id ?? randomUUID();
    const time = await this.clock.next(definition, id, this.salt, now, now);
    assertCurrent?.();
    if (previous) previous = this.matching(previous.id, previous.version);
    if (definition.schedule.kind === "once" && definition.schedule.at <= this.now()) throw new Error("一次性任务请选择未来的时间");
    if (!time) throw new Error("时间规则没有未来的运行时间");
    const task: Automation = { ...definition, id, version: (previous?.version ?? 0) + 1,
      status: previous?.status === "paused" ? "paused" : "active", schedule_anchor_at: now, next_nominal_at: time.nominal, next_run_at: time.due,
      recheck_at: null, blocked_reason: null, last_triggered_at: previous?.last_triggered_at ?? null,
      created_at: previous?.created_at ?? now, updated_at: now };
    this.options.store.save(task, previous?.version ?? null);
    this.changed();
    return task;
  }
  async setStatus(id: string, version: number, status: "active" | "paused", assertCurrent?: () => void): Promise<Automation> {
    let task = this.matching(id, version);
    if (status === "active") {
      if (task.status === "finished") throw new Error("任务计划已结束，请编辑时间后重新启用");
      await this.options.execution.validate(task);
      assertCurrent?.();
      task = this.matching(id, version);
      const now = this.now();
      if (task.schedule.kind === "once" && task.schedule.at <= now) throw new Error("原定时间已过，请重新选择执行时间");
      const time = task.schedule.kind === "once" ? { nominal: task.schedule.at, due: task.schedule.at }
        : await this.clock.next(task, task.id, this.salt, now, now);
      assertCurrent?.(); task = this.matching(id, version);
      task = { ...task, status: time ? "active" : "finished", schedule_anchor_at: now, next_nominal_at: time?.nominal ?? null, next_run_at: time?.due ?? null };
    } else task = { ...task, status };
    task = { ...task, version: task.version + 1, updated_at: this.now(), recheck_at: null, blocked_reason: null };
    this.options.store.save(task, version);
    this.changed();
    return task;
  }
  delete(id: string, version: number): void {
    const task = this.matching(id, version);
    this.options.store.save({ ...task, status: "deleted", version: version + 1, updated_at: this.now() }, version);
    this.changed();
  }
  pauseSession(sessionId: string, reason: string): void {
    for (const task of this.list()) if (task.target.mode === "reuse" && task.target.session_id === sessionId && task.status === "active") {
      this.options.store.save({ ...task, status: "paused", blocked_reason: reason, version: task.version + 1, updated_at: this.now() }, task.version);
    }
    this.changed();
  }
  setEditing(sessionId: string, editing: boolean): void {
    if (editing) this.editing.set(sessionId, this.now()); else this.editing.delete(sessionId);
  }
  async preview(definition: AutomationDefinition): Promise<{ times: number[]; jitter_seconds: number }> {
    const task = parseAutomationDefinition(definition);
    validateAutomationTime(task);
    return this.clock.preview(task, this.now());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(error => this.options.onError?.(error)); }, 30_000);
    this.timer.unref?.();
    void this.tick().catch(error => this.options.onError?.(error));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.clock.close();
    await this.ticking;
    await Promise.allSettled([...this.pendingDispatches]);
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    if (this.stopped || !this.options.execution.ready()) return Promise.resolve();
    this.ticking = this.tickOnce().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async tickOnce(): Promise<void> {
    if (!this.recovered) {
      for (const run of this.options.store.runs(undefined, Number.MAX_SAFE_INTEGER)) if (run.dispatch_state === "prepared") {
        try {
          const state = await this.options.execution.observe(run);
          this.options.store.saveRun({ ...run, dispatch_state: state === "missing" || state === "unknown" ? "unknown" : "accepted",
            error: state === "missing" || state === "unknown" ? "启动回执未确认；未自动重发，请查看会话后决定是否重新运行" : null });
        } catch (error) {
          this.options.store.saveRun({ ...run, dispatch_state: "unknown", error: diagnostic(error) });
        }
      }
      this.recovered = true;
    }
    const now = this.now();
    const due = this.list().filter(task => task.status === "active" && task.next_run_at !== null && task.next_run_at <= now
      && (task.recheck_at ?? 0) <= now && (task.last_triggered_at === null || now - task.last_triggered_at >= 60_000)
      && !this.dispatching.has(task.id))
      .sort((a, b) => a.next_run_at! - b.next_run_at! || a.id.localeCompare(b.id)).slice(0, 3);
    for (const task of due) {
      if (this.stopped || !this.options.execution.ready()) break;
      try { await this.dispatch(task.id, "scheduled"); }
      catch (error) {
        const current = this.options.store.get(task.id);
        if (current?.version === task.version && current.status === "active") {
          this.options.store.save({ ...current, recheck_at: this.now() + 60_000, blocked_reason: diagnostic(error),
            ...(error instanceof AutomationTargetMissingError ? { status: "paused" as const, version: current.version + 1 } : {}) }, current.version);
        }
        if (!(error instanceof AutomationBlockedError)) this.options.onError?.(error);
      }
    }
    this.changed();
  }
  runNow(id: string, assertCurrent?: () => void): Promise<AutomationRun> {
    const pending = this.dispatch(id, "manual", assertCurrent);
    this.pendingDispatches.add(pending);
    void pending.finally(() => this.pendingDispatches.delete(pending)).catch(() => {});
    return pending;
  }
  private assertNotEditing(task: Automation): void {
    if (task.target.mode === "reuse" && this.now() - (this.editing.get(task.target.session_id) ?? -Infinity) < 120_000) {
      throw new AutomationBlockedError("正在编辑此会话，稍后再试");
    }
  }
  private async dispatch(id: string, trigger: AutomationRun["trigger"], assertRequester?: () => void): Promise<AutomationRun> {
    if (this.stopped || !this.options.execution.ready()) throw new AutomationBlockedError("Agent 尚未就绪");
    if (this.dispatching.has(id)) throw new AutomationBlockedError("该任务正在启动");
    this.dispatching.add(id);
    try {
      const task = this.get(id);
      if (trigger === "scheduled" && task.status !== "active") throw new AutomationBlockedError("任务已暂停");
      if (task.schedule.kind === "once" && task.status === "finished") throw new AutomationBlockedError("一次性任务已触发，请编辑时间后再运行");
      this.assertNotEditing(task);
      const blocked = await this.options.execution.blockReason(task);
      if (blocked) throw new AutomationBlockedError(blocked);
      assertRequester?.();
      this.matching(id, task.version);
      const now = this.now();
      const advance = trigger === "scheduled" || task.target.mode === "reuse" || task.schedule.kind === "once";
      const after = task.schedule.kind === "interval" ? now : Math.max(now, task.next_nominal_at ?? now);
      const time = advance ? (task.schedule.kind === "once" ? null : await this.clock.next(task, id, this.salt, after, task.schedule_anchor_at)) : null;
      assertRequester?.();
      if (this.stopped) throw new AutomationBlockedError("任务调度已停止");
      this.assertNotEditing(task);
      this.matching(id, task.version);
      const next: Automation = { ...task, recheck_at: null, blocked_reason: null, last_triggered_at: now,
        ...(advance ? { next_nominal_at: time?.nominal ?? null, next_run_at: time?.due ?? null,
          status: time ? task.status : "finished" as const } : {}) };
      const run: AutomationRun = { id: randomUUID(), automation_id: id, automation_version: task.version,
        definition: { name: task.name, prompt: task.prompt, timezone: task.timezone, schedule: task.schedule, target: task.target },
        trigger, nominal_at: trigger === "scheduled" ? task.next_nominal_at! : now,
        session_id: task.target.mode === "reuse" ? task.target.session_id : randomUUID(), turn_id: randomUUID(),
        dispatch_state: "prepared", error: null, created_at: now, accepted_at: null };
      if (!this.options.store.claim(task, next, run)) throw new AutomationBlockedError("任务配置或调度状态已改变，请重试");
      try {
        await this.options.execution.submit(run, () => {
          assertRequester?.();
          this.assertNotEditing(task);
          const current = this.options.store.get(id);
          if (this.stopped || !current || current.version !== task.version || current.status === "deleted"
            || trigger === "scheduled" && current.status === "paused") throw new AutomationBlockedError("任务在启动前已暂停、修改或删除");
        });
        run.dispatch_state = "accepted"; run.accepted_at = this.now();
      } catch (error) {
        run.dispatch_state = error instanceof AutomationBlockedError ? "failed" : "unknown";
        run.error = diagnostic(error);
        // Failed admission consumed no turn: retain the single scheduled opportunity.
        const current = this.options.store.get(id);
        if (error instanceof AutomationBlockedError && trigger === "scheduled" && current?.version === task.version && current.status !== "deleted") {
          this.options.store.save({ ...task, recheck_at: this.now() + 60_000, blocked_reason: run.error }, task.version);
        }
      }
      this.options.store.saveRun(run);
      this.changed();
      return run;
    } finally { this.dispatching.delete(id); }
  }
  async runs(id: string, limit = 50): Promise<AutomationRunView[]> {
    return Promise.all(this.options.store.runs(id, limit).map(async run => {
      try {
        const state = await this.options.execution.observe(run);
        return { ...run, execution_state: state === "missing" ? "unknown" as const : state };
      } catch (error) { return { ...run, execution_state: "unknown" as const, execution_error: diagnostic(error) }; }
    }));
  }
}
