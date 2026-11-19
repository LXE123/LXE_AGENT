import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, CircleAlert, CircleCheck, CircleX, LoaderCircle, Play, RefreshCw, Square, Trash2, X } from "lucide-react";
import type { SessionPayload } from "@lxe/desktop-protocol";
import { useUserSkillsQuery } from "../../api/queries";
import { sessionActions } from "../../api/session-actions";
import { useUiText } from "../../shared/i18n";
import { failureOf, filesApi } from "../file-preview/api";
import { OpenFileButton } from "../file-preview/OpenFileButton";
import { FullAccessConfirmation } from "../sessions/permissions";
import { WorkbenchPageHeader } from "./page-header";
import {
  FBA_CAPACITY_SITES, FBA_CAPACITY_SKILL, FBA_CAPACITY_STORES, capacityPrompt, conversationDeleted, forgetRun, loadFullAccess, loadRuns, loadSelection, orderedSelection,
  outputFolder, recordRun, resultFiles, runState, saveFullAccess, saveSelection, settled,
  type FbaCapacityRun, type FbaCapacityRunState, type FbaCapacitySelection,
} from "./fba-capacity-run";
import "./detail-theme.css";
import "./fba-capacity.css";

const POLL_MS = 4_000;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const toggled = <T,>(items: readonly T[], item: T) => items.includes(item) ? items.filter(value => value !== item) : [...items, item];
const time = (value: number) => new Date(value).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Workbook = { name: string; path: string };

/**
 * A Full access run gets its session first so the mode is set before the task starts:
 * register the default workspace, open a blank session there, raise it, then send.
 */
async function fullAccessSession(directory: string): Promise<string> {
  const workspace = await sessionActions.registerWorkspace(directory);
  const session = await sessionActions.create(workspace.workspace_id);
  try {
    await sessionActions.setPermission(session.session_id, "danger-full-access");
  } catch (cause) {
    await sessionActions.delete(session.session_id).catch(() => undefined);
    throw cause;
  }
  return session.session_id;
}

export function FbaCapacityWorkbench({ ready, defaultDirectory, onBack, onOpenSession, onInstallSkill }: {
  ready: boolean;
  /** The configured default workspace; Full access runs open their session there. */
  defaultDirectory: string;
  onBack(): void;
  onOpenSession(session: SessionPayload, turnId: string): Promise<void>;
  onInstallSkill(): void;
}) {
  const copy = useUiText().fbaCapacity;
  const desktop = Boolean(window.lxe?.desktop);
  const [selection, setSelection] = useState<FbaCapacitySelection>(() => loadSelection());
  const [runs, setRuns] = useState<FbaCapacityRun[]>(() => loadRuns());
  const [activeId, setActiveId] = useState<string | null>(() => loadRuns()[0]?.id ?? null);
  const [state, setState] = useState<FbaCapacityRunState | null>(null);
  const [results, setResults] = useState<Workbook[] | null>(null);
  const [resultError, setResultError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fullAccess, setFullAccess] = useState(() => loadFullAccess());
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [pastStates, setPastStates] = useState<Record<string, FbaCapacityRunState>>({});
  // Runs whose conversation was deleted; their files stay in the workspace but the page can no longer reach them.
  const [deleted, setDeleted] = useState<Record<string, true>>({});
  const active = runs.find(run => run.id === activeId) ?? null;
  const latest = runs[0] ?? null;
  // Only one run at a time, whichever run is on screen: the newest run's own state decides,
  // and an unknown state counts as busy until a lookup says otherwise.
  const latestState = latest === null ? null : latest.id === active?.id ? state : pastStates[latest.id] ?? null;
  const latestBusy = latest !== null && (latestState === null || !settled(latestState));

  const skills = useUserSkillsQuery();
  const installed = skills.data ? skills.data.items.some(item => item.name === FBA_CAPACITY_SKILL && item.available) : null;

  const conversationGone = useCallback(async (run: FbaCapacityRun) => {
    try { await sessionActions.detail({ session_id: run.session_id, message_limit: 1 }); return false; }
    catch (cause) { return conversationDeleted(cause); }
  }, []);

  const loadResults = useCallback(async (run: FbaCapacityRun) => {
    try {
      const listing = await filesApi().call({ operation: "list", input: { session_id: run.session_id, path: run.output } });
      setResults(resultFiles(listing.entries)); setResultError("");
    } catch (cause) {
      // A run that has not written anything yet has no folder; that is not an error to show.
      const failure = failureOf(cause, "list");
      if (failure.kind === "not_found") { setResults([]); setResultError(""); }
      else setResultError(failure.diagnostic);
    }
  }, []);

  useEffect(() => {
    setState(null); setResults(null); setResultError("");
    if (!active || !ready) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { state: phase } = await sessionActions.turnState(active.session_id, active.turn_id);
        let waiting = { question: false, approval: false };
        if (phase === "running") {
          const [questions, approvals] = await Promise.all([
            sessionActions.questions(),
            sessionActions.approvals(),
          ]);
          waiting = { question: questions.items.some(item => item.session_id === active.session_id), approval: approvals.items.some(item => item.session_id === active.session_id) };
        }
        if (!current) return;
        const next = runState(phase, waiting);
        setState(next);
        setPastStates(previous => previous[active.id] === next ? previous : { ...previous, [active.id]: next });
        if (settled(next)) {
          if (await conversationGone(active)) { if (current) setDeleted(previous => ({ ...previous, [active.id]: true })); return; }
          if (current && next !== "missing") await loadResults(active);
          return;
        }
      } catch (cause) { if (current) setError(errorText(cause)); }
      if (current) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [active, ready, loadResults, conversationGone]);

  // Elapsed time ticks only while the shown run is still going.
  const ticking = state !== null && !settled(state);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);

  // Older runs in the history are looked up until they settle, so each row shows how it ended.
  const pastRef = useRef(pastStates); pastRef.current = pastStates;
  useEffect(() => {
    if (!ready || runs.length < 2) return;
    let current = true, timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const open = runs.filter(run => run.id !== activeId && !(pastRef.current[run.id] && settled(pastRef.current[run.id]!)));
      if (!open.length) return;
      const found = await Promise.all(open.map(async run => {
        try { return [run.id, runState((await sessionActions.turnState(run.session_id, run.turn_id)).state, { question: false, approval: false })] as const; }
        catch { return [run.id, "unknown" as const] as const; }
      }));
      if (!current) return;
      setPastStates(previous => ({ ...previous, ...Object.fromEntries(found) }));
      if (found.some(([, value]) => !settled(value))) timer = setTimeout(() => void check(), POLL_MS);
    };
    void check();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [ready, runs, activeId]);

  const change = (next: FbaCapacitySelection) => { setSelection(next); saveSelection(next); setError(""); };

  const start = async () => {
    const chosen = orderedSelection(selection);
    if (chosen.stores.length === 0) { setError(copy.needStore); return; }
    if (chosen.sites.length === 0) { setError(copy.needSite); return; }
    setBusy(true); setError("");
    try {
      const output = outputFolder(new Date());
      const text = capacityPrompt(chosen, output);
      if (fullAccess && !defaultDirectory) throw new Error(copy.noWorkspace);
      // Without Full access there is no session yet: the send opens one in the default workspace.
      const sent = fullAccess
        ? await sessionActions.send({ session_id: await fullAccessSession(defaultDirectory), text })
        : await sessionActions.send({ text });
      const run: FbaCapacityRun = { id: sent.turn_id, created_at: Date.now(), ...chosen, session_id: sent.session_id, turn_id: sent.turn_id, output, ...(fullAccess ? { full_access: true } : {}) };
      setRuns(recordRun(run)); setActiveId(run.id);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const act = async (action: () => Promise<unknown>) => {
    setError("");
    try { await action(); } catch (cause) { setError(errorText(cause)); }
  };
  // The Gateway takes a turn id only for the turn that is executing. A queued run is the first turn
  // in its own new session, so stopping by session clears it without touching anything older.
  const stop = (run: FbaCapacityRun, phase: FbaCapacityRunState) =>
    act(() => sessionActions.stop(run.session_id, phase === "queued" ? undefined : run.turn_id));
  const openConversation = (run: FbaCapacityRun) => act(async () => {
    try {
      const detail = await sessionActions.detail({ session_id: run.session_id, message_limit: 1 });
      await onOpenSession(detail.session, run.turn_id);
    } catch (cause) {
      if (!conversationDeleted(cause)) throw cause;
      setDeleted(previous => ({ ...previous, [run.id]: true }));
    }
  });
  const forget = (run: FbaCapacityRun) => {
    const next = forgetRun(run.id);
    setRuns(next); setActiveId(next[0]?.id ?? null);
  };

  const storesAll = selection.stores.length === FBA_CAPACITY_STORES.length;
  const sitesAll = selection.sites.length === FBA_CAPACITY_SITES.length;
  const canStart = ready && desktop && installed === true && !busy && !latestBusy;
  const waiting = state === "waiting_input" || state === "waiting_approval";
  const viewingPast = active !== null && latest !== null && active.id !== latest.id;
  const gone = active !== null && deleted[active.id] === true;
  const sitesText = (sites: readonly string[]) => sites.length === FBA_CAPACITY_SITES.length ? copy.allSites : sites.join(" ");
  const storesText = (stores: readonly string[]) => stores.length > 2 ? `${stores.slice(0, 2).join("、")} +${stores.length - 2}` : stores.join("、");
  const note = !ready ? copy.notReady : installed === null && desktop ? copy.checkingSkill : latestBusy && latestState !== null ? copy.runInProgress : "";

  return <section className="workbench-tool-view workbench-detail fba-capacity" aria-labelledby="fba-capacity-title">
    <WorkbenchPageHeader title={copy.title} titleId="fba-capacity-title" description={copy.subtitle} onBack={onBack} />
    {!desktop ? <p className="workbench-error" role="alert">{copy.unavailable}</p> : null}
    {error ? <p className="workbench-error" role="alert">{error}</p> : null}
    {skills.error ? <p className="workbench-error" role="alert">{errorText(skills.error)}</p> : null}
    {desktop && installed === false ? <p className="fba-capacity-notice" role="status">
      {copy.skillMissing}<button type="button" onClick={onInstallSkill}>{copy.installSkill}<ArrowUpRight size={14} aria-hidden /></button>
    </p> : null}

    <div className="fba-capacity-layout">
    <div className="fba-capacity-side">
    <article className="workbench-settings-card fba-capacity-form">
      <fieldset>
        <legend>
          {copy.stores}<span className="fba-capacity-count">{copy.selected(selection.stores.length, FBA_CAPACITY_STORES.length)}</span>
          <button type="button" className="fba-capacity-link" onClick={() => change({ ...selection, stores: storesAll ? [] : [...FBA_CAPACITY_STORES] })}>{storesAll ? copy.clear : copy.selectAll}</button>
        </legend>
        <div className="fba-capacity-chips" data-kind="stores">
          {FBA_CAPACITY_STORES.map(store => <label key={store} className="fba-capacity-chip">
            <input type="checkbox" checked={selection.stores.includes(store)} onChange={() => change({ ...selection, stores: toggled(selection.stores, store) })} />
            <span><Check size={13} aria-hidden />{store}</span>
          </label>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>
          {copy.sites}<span className="fba-capacity-count">{copy.selected(selection.sites.length, FBA_CAPACITY_SITES.length)}</span>
          <button type="button" className="fba-capacity-link" onClick={() => change({ ...selection, sites: sitesAll ? [] : [...FBA_CAPACITY_SITES] })}>{sitesAll ? copy.clear : copy.selectAll}</button>
        </legend>
        <div className="fba-capacity-chips" data-kind="sites">
          {FBA_CAPACITY_SITES.map(site => <label key={site} className="fba-capacity-chip">
            <input type="checkbox" checked={selection.sites.includes(site)} onChange={() => change({ ...selection, sites: toggled(selection.sites, site) as typeof selection.sites })} />
            <span><Check size={13} aria-hidden />{site}<small>{copy.siteNames[site] ?? site}</small></span>
          </label>)}
        </div>
      </fieldset>
      <div className="fba-capacity-access">
        <label className="fba-capacity-switch">
          <input type="checkbox" role="switch" checked={fullAccess} disabled={busy}
            onChange={event => {
              if (event.target.checked) { setConfirmFullAccess(true); return; }
              setFullAccess(false); saveFullAccess(false);
            }} />
          <span>{copy.fullAccess}</span>
        </label>
        <p className="fba-capacity-hint">{copy.fullAccessHint}</p>
      </div>
      <div className="fba-capacity-start">
        <button className="workbench-primary-button" type="button" disabled={!canStart} onClick={() => void start()}>
          {busy ? <LoaderCircle className="spin" size={14} aria-hidden /> : <Play size={14} aria-hidden />}{busy ? copy.starting : copy.start}
        </button>
        {note ? <span className="fba-capacity-hint">{note}</span> : null}
      </div>
    </article>

    {runs.length > 1 ? <article className="workbench-settings-card fba-capacity-history" aria-labelledby="fba-capacity-history-title">
      <h2 id="fba-capacity-history-title">{copy.history}</h2>
      <ul>{runs.map(run => {
        const shown = run.id === activeId ? state : pastStates[run.id] ?? null;
        return <li key={run.id}>
          <button type="button" aria-current={run.id === activeId ? "true" : undefined} onClick={() => setActiveId(run.id)}>
            <span className="fba-capacity-dot" data-state={deleted[run.id] ? "deleted" : shown ?? "loading"} aria-hidden />
            <span className="fba-capacity-history-main">
              <span>{storesText(run.stores)}</span>
              <small>{time(run.created_at)} · {sitesText(run.sites)}</small>
            </span>
            <span className="fba-capacity-history-state">{deleted[run.id] ? copy.conversationDeleted : shown ? copy.states[shown] : "…"}</span>
          </button>
        </li>;
      })}</ul>
    </article> : null}
    </div>

    <div className="fba-capacity-main">
    {active ? <article className="workbench-settings-card fba-capacity-run" aria-labelledby="fba-capacity-run-title">
      {viewingPast ? <p className="fba-capacity-past" role="status">
        {copy.viewingPast(time(active.created_at))}
        <button type="button" className="fba-capacity-link" onClick={() => setActiveId(latest.id)}>{copy.backToLatest}</button>
      </p> : null}
      <header className="fba-capacity-run-header">
        <div>
          <h2 id="fba-capacity-run-title">{copy.current}</h2>
          <p className="fba-capacity-meta">{time(active.created_at)} · {copy.storeCount(active.stores.length)} · {sitesText(active.sites)}{active.full_access ? ` · ${copy.fullAccessTag}` : ""}</p>
        </div>
        {gone ? <span className="fba-capacity-state" data-state="deleted" role="status"><Trash2 size={14} aria-hidden />{copy.conversationDeleted}</span>
          : <StateBadge state={state} label={state ? copy.states[state] ?? state : "…"} />}
      </header>

      {state && !settled(state) ? <section className="fba-capacity-progress" aria-label={copy.scope}>
        <p className="fba-capacity-elapsed">{copy.elapsed(copy.duration(now - active.created_at))}</p>
        <p className="fba-capacity-hint">{waiting ? copy.waitingHint : copy.runningHint}</p>
        <h3>{copy.scope}</h3>
        <ul className="fba-capacity-scope">
          {active.stores.map(store => <li key={store}><span>{store}</span><small>{sitesText(active.sites)}</small></li>)}
        </ul>
      </section> : null}

      {gone ? <p className="fba-capacity-hint">{copy.deletedHint}</p> : null}
      <div className="fba-capacity-actions">
        {!gone ? <button type="button" onClick={() => void openConversation(active)}>{copy.openConversation}<ArrowUpRight size={14} aria-hidden /></button> : null}
        {!gone && state && !settled(state) && state !== "stopping" ? <button type="button" onClick={() => void stop(active, state)}><Square size={13} aria-hidden />{copy.stop}</button> : null}
        {!gone && state && settled(state) && state !== "missing" ? <button type="button" onClick={() => void loadResults(active)}><RefreshCw size={13} aria-hidden />{copy.refresh}</button> : null}
        {gone || (state && settled(state)) ? <button type="button" className="fba-capacity-forget" onClick={() => forget(active)}><X size={13} aria-hidden />{copy.forget}</button> : null}
        <span className="fba-capacity-output" title={active.output}>{copy.output}：<code>{active.output}</code></span>
      </div>
      {resultError ? <p className="workbench-error" role="alert">{resultError}</p> : null}
      {results && !gone ? results.length ? <section className="fba-capacity-files" aria-label={copy.workbooks}>
          <h3>{copy.workbooks}</h3>
          <ul>{results.map(book => <li key={book.path}>
            <span>{book.name}</span>
            <OpenFileButton file={{ session_id: active.session_id, kind: "workspace", path: book.path }} label />
          </li>)}</ul>
        </section> : <p className="fba-capacity-hint">{copy.noOutput}</p> : null}
    </article> : <p className="fba-capacity-empty">{copy.noRuns}</p>}
    </div>
    </div>
    {confirmFullAccess ? <FullAccessConfirmation pending={false} ready error=""
      onCancel={() => setConfirmFullAccess(false)}
      onConfirm={() => { setFullAccess(true); saveFullAccess(true); setConfirmFullAccess(false); }} /> : null}
  </section>;
}

/** Status in words with a matching icon; colour pairs follow the CDS background and text roles. */
function StateBadge({ state, label }: { state: FbaCapacityRunState | null; label: string }) {
  const moving = state === null || state === "queued" || state === "running" || state === "stopping";
  const Icon = moving ? LoaderCircle : state === "completed" ? CircleCheck : state === "error" || state === "missing" ? CircleX : CircleAlert;
  return <span className="fba-capacity-state" data-state={state ?? "loading"} role="status">
    <Icon className={moving ? "spin" : undefined} size={14} aria-hidden />{label}
  </span>;
}
