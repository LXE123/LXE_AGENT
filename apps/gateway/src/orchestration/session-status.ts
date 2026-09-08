import { randomUUID } from "node:crypto";
import type { SessionRunSummary, SessionRunUpdate, SessionStatusRequest, SessionStatusSnapshot } from "@lxe/desktop-protocol";
import type { SchedulerJobStateEvent } from "./scheduler";

export class SessionStatusCoordinator {
  private readonly owner = randomUUID();
  private sequence = 0;
  private revision = 0;
  private pending: SessionRunUpdate[] = [];
  private unpublished = new Map<string, SessionRunSummary>();
  private work: Promise<void> | undefined;
  private reconcile = true;
  private ready = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: {
    request: (request: SessionStatusRequest) => Promise<SessionRunSummary[]>;
    live: () => Omit<SessionRunUpdate,"event_version">[];
    publish: (snapshot: SessionStatusSnapshot) => void;
    onError: (error: Error) => void;
  }) {}
  event(event: SchedulerJobStateEvent): void {
    this.pending.push({session_id:event.job.session_id,turn_id:event.job.job_id,state:event.state === "cleared" ? "cancelled" : event.state,event_version:++this.sequence});
    // The scheduler finishes its entire drain before this microtask takes a batch.
    queueMicrotask(() => { void this.flush().catch(() => {}); });
  }
  setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    if (!ready) { this.reconcile = true; return; }
    void this.flush().catch(() => {});
  }
  private publish(items: SessionRunSummary[]): void {
    if (items.length) this.options.publish({epoch:this.owner,revision:++this.revision,items:this.overlayLive(items)});
  }
  private overlayLive(items:SessionRunSummary[]):SessionRunSummary[]{
    const live=this.options.live();
    return items.map(item=>{
      const run=live.find(r=>r.session_id===item.session_id&&r.state!=="queued")??live.find(r=>r.session_id===item.session_id);
      if(!run||item.error)return item;
      return {session_id:item.session_id,version:item.version,state:run.state};
    });
  }
  flush(): Promise<void> {
    if (!this.ready) return Promise.resolve();
    if (this.work) return this.work;
    this.work = Promise.resolve().then(async () => {
      const changed = this.unpublished;
      if (this.reconcile) {
        this.reconcile = false;
        const stamp = ++this.sequence;
        let items: SessionRunSummary[];
        try {
          items = await this.options.request({action:"reconcile",owner:this.owner,live:this.options.live().map(run => ({...run,event_version:stamp}))});
        } catch (error) { this.reconcile = true; throw error; }
        for (const item of items) changed.set(item.session_id, item);
      }
      while (this.pending.length && this.ready) {
        const batch = this.pending.splice(0);
        try {
          const items = await this.options.request({action:"apply",owner:this.owner,updates:batch});
          for (const item of items) changed.set(item.session_id, item);
        }
        catch (error) { this.pending.unshift(...batch); throw error; }
      }
      // Reconciliation and queue advancement appear together, including sessions
      // with no new events whose abandoned run just became unknown.
      this.publish([...changed.values()]);
      changed.clear();
    }).catch(cause => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.options.onError(error);
      const ids = new Set([...this.unpublished.keys(),...this.pending.map(u=>u.session_id),...this.options.live().map(u=>u.session_id)]);
      this.publish([...ids].map(session_id=>({session_id,version:0,state:"unknown",error:error.message})));
      if (!this.retry) {
        this.retry = setTimeout(() => { this.retry=undefined;void this.flush().catch(()=>{}); },1000);
        this.retry.unref?.();
      }
      throw error;
    }).finally(() => {
      this.work=undefined;
      if (this.ready && !this.retry && (this.pending.length || this.reconcile)) {
        queueMicrotask(() => { void this.flush().catch(() => {}); });
      }
    });
    return this.work;
  }
  async list(session_ids: string[]): Promise<SessionStatusSnapshot> {
    await this.flush();
    const revision=this.revision;
    return {epoch:this.owner,revision,items:this.overlayLive(await this.options.request({action:"list",session_ids}))};
  }
  async ack(session_id:string,turn_id:string,version:number):Promise<SessionStatusSnapshot> {
    await this.flush();
    const revision=++this.revision;
    const items=await this.options.request({action:"ack",session_id,turn_id,version});
    const snapshot={epoch:this.owner,revision,items:this.overlayLive(items)};
    this.options.publish(snapshot);
    return snapshot;
  }
  async stop(): Promise<void> {
    try { await this.flush(); } catch { /* Actual persistence error was reported; shutdown still completes. */ }
    this.ready=false;
    if(this.retry)clearTimeout(this.retry);
  }
}
