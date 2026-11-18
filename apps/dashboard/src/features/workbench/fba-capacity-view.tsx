import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, LoaderCircle, Play, RefreshCw, Square } from "lucide-react";
import type { SessionPayload } from "@lxe/desktop-protocol";
import { useUserSkillsQuery } from "../../api/queries";
import { sessionActions } from "../../api/session-actions";
import { useUiText } from "../../shared/i18n";
import { failureOf, filesApi } from "../file-preview/api";
import { DocumentViewer } from "../file-preview/DocumentViewer";
import { OpenFileButton } from "../file-preview/OpenFileButton";
import { readingState } from "../file-preview/reading-state";
import { WorkbenchPageHeader } from "./page-header";
import {
  FBA_CAPACITY_SITES, FBA_CAPACITY_SKILL, FBA_CAPACITY_STORES, capacityPrompt, loadRuns, loadSelection, orderedSelection,
  outputFolder, recordRun, resultFiles, runState, saveSelection, settled,
  type FbaCapacityRun, type FbaCapacityRunState, type FbaCapacitySelection,
} from "./fba-capacity-run";
import "./detail-theme.css";
import "./fba-capacity.css";

const POLL_MS = 4_000;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const toggled = <T,>(items: readonly T[], item: T) => items.includes(item) ? items.filter(value => value !== item) : [...items, item];
const time = (value: number) => new Date(value).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Results = { report: string | null; workbooks: Array<{ name: string; path: string }> };

export function FbaCapacityWorkbench({ ready, onBack, onOpenSession, onInstallSkill }: {
  ready: boolean;
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
  const [results, setResults] = useState<Results | null>(null);
  const [resultError, setResultError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = runs.find(run => run.id === activeId) ?? null;
  const latest = runs[0] ?? null;
  const latestBusy = latest !== null && latest.id === active?.id && state !== null && !settled(state);

  const skills = useUserSkillsQuery();
  const installed = skills.data ? skills.data.items.some(item => item.name === FBA_CAPACITY_SKILL && item.available) : null;

  const loadResults = useCallback(async (run: FbaCapacityRun) => {
    try {
      const listing = await filesApi().call({ operation: "list", input: { session_id: run.session_id, path: run.output } });
      setResults(resultFiles(listing.entries)); setResultError("");
    } catch (cause) {
      // A run that has not written anything yet has no folder; that is not an error to show.
      const failure = failureOf(cause, "list");
      if (failure.kind === "not_found") { setResults({ report: null, workbooks: [] }); setResultError(""); }
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
        if (settled(next)) { if (next !== "missing") await loadResults(active); return; }
      } catch (cause) { if (current) setError(errorText(cause)); }
      if (current) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [active, ready, loadResults]);

  const change = (next: FbaCapacitySelection) => { setSelection(next); saveSelection(next); setError(""); };

  const start = async () => {
    const chosen = orderedSelection(selection);
    if (chosen.stores.length === 0) { setError(copy.needStore); return; }
    if (chosen.sites.length === 0) { setError(copy.needSite); return; }
    setBusy(true); setError("");
    try {
      const output = outputFolder(new Date());
      // No directory: the session opens in the default workspace, like the sidebar's 新对话.
      const sent = await sessionActions.send({ text: capacityPrompt(chosen, output) });
      const run: FbaCapacityRun = { id: sent.turn_id, created_at: Date.now(), ...chosen, session_id: sent.session_id, turn_id: sent.turn_id, output };
      setRuns(recordRun(run)); setActiveId(run.id);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };

  const act = async (action: () => Promise<unknown>) => {
    setError("");
    try { await action(); } catch (cause) { setError(errorText(cause)); }
  };
  const openConversation = (run: FbaCapacityRun) => act(async () => {
    const detail = await sessionActions.detail({ session_id: run.session_id, message_limit: 1 });
    await onOpenSession(detail.session, run.turn_id);
  });

  const storesAll = selection.stores.length === FBA_CAPACITY_STORES.length;
  const sitesAll = selection.sites.length === FBA_CAPACITY_SITES.length;
  const canStart = ready && desktop && installed === true && !busy && !latestBusy;
  const waiting = state === "waiting_input" || state === "waiting_approval";

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
        <legend>{copy.stores}<button type="button" className="fba-capacity-link" onClick={() => change({ ...selection, stores: storesAll ? [] : [...FBA_CAPACITY_STORES] })}>{storesAll ? copy.clear : copy.selectAll}</button></legend>
        <div className="fba-capacity-chips">
          {FBA_CAPACITY_STORES.map(store => <label key={store} className="fba-capacity-chip">
            <input type="checkbox" checked={selection.stores.includes(store)} onChange={() => change({ ...selection, stores: toggled(selection.stores, store) })} />
            <span>{store}</span>
          </label>)}
        </div>
      </fieldset>
      <fieldset>
        <legend>{copy.sites}<button type="button" className="fba-capacity-link" onClick={() => change({ ...selection, sites: sitesAll ? [] : [...FBA_CAPACITY_SITES] })}>{sitesAll ? copy.clear : copy.selectAll}</button></legend>
        <div className="fba-capacity-chips">
          {FBA_CAPACITY_SITES.map(site => <label key={site} className="fba-capacity-chip">
            <input type="checkbox" checked={selection.sites.includes(site)} onChange={() => change({ ...selection, sites: toggled(selection.sites, site) as typeof selection.sites })} />
            <span>{copy.siteNames[site] ?? site}<small>{site}</small></span>
          </label>)}
        </div>
      </fieldset>
      <div className="fba-capacity-start">
        <button className="workbench-primary-button" type="button" disabled={!canStart} onClick={() => void start()}>
          {busy ? <LoaderCircle className="spin" size={14} aria-hidden /> : <Play size={14} aria-hidden />}{busy ? copy.starting : copy.start}
        </button>
        {!ready ? <span className="workbench-note">{copy.notReady}</span>
          : installed === null && desktop ? <span className="workbench-note">{copy.checkingSkill}</span>
          : latestBusy ? <span className="workbench-note">{copy.runInProgress}</span> : null}
      </div>
    </article>

    {runs.length > 1 ? <article className="workbench-settings-card fba-capacity-history" aria-labelledby="fba-capacity-history-title">
      <h2 id="fba-capacity-history-title">{copy.history}</h2>
      <ul>{runs.map(run => <li key={run.id}>
        <button type="button" aria-current={run.id === activeId ? "true" : undefined} onClick={() => setActiveId(run.id)}>
          <span>{time(run.created_at)}</span>
          <span>{run.stores.join("、")}</span>
        </button>
      </li>)}</ul>
    </article> : null}
    </div>

    <div className="fba-capacity-main">
    {active ? <article className="workbench-settings-card fba-capacity-run" aria-labelledby="fba-capacity-run-title">
      <header className="fba-capacity-run-header">
        <div>
          <h2 id="fba-capacity-run-title">{copy.current}</h2>
          <p className="workbench-note">{time(active.created_at)} · {copy.storeCount(active.stores.length)} · {active.sites.length === FBA_CAPACITY_SITES.length ? copy.allSites : active.sites.join(" ")}</p>
        </div>
        <span className="fba-capacity-state" data-state={state ?? "loading"} role="status">
          {state === null || (!settled(state) && state !== "unknown") ? <LoaderCircle className={state === null || state === "queued" || state === "running" ? "spin" : ""} size={14} aria-hidden /> : null}
          {state ? copy.states[state] : "…"}
        </span>
      </header>
      {state && !settled(state) ? <p className="workbench-note">{waiting ? copy.waitingHint : copy.runningHint}</p> : null}
      <div className="fba-capacity-actions">
        <button type="button" onClick={() => void openConversation(active)}>{copy.openConversation}<ArrowUpRight size={14} aria-hidden /></button>
        {state && !settled(state) && state !== "stopping" ? <button type="button" onClick={() => void act(() => sessionActions.stop(active.session_id, active.turn_id))}><Square size={13} aria-hidden />{copy.stop}</button> : null}
        {state && settled(state) && state !== "missing" ? <button type="button" onClick={() => void loadResults(active)}><RefreshCw size={13} aria-hidden />{copy.refresh}</button> : null}
        <span className="fba-capacity-output">{copy.output}：<code>{active.output}</code></span>
      </div>
      {resultError ? <p className="workbench-error" role="alert">{resultError}</p> : null}
      {results ? <>
        {results.workbooks.length ? <section className="fba-capacity-files" aria-label={copy.workbooks}>
          <h3>{copy.workbooks}</h3>
          <ul>{results.workbooks.map(book => <li key={book.path}>
            <span>{book.name}</span>
            <OpenFileButton file={{ session_id: active.session_id, kind: "workspace", path: book.path }} label />
          </li>)}</ul>
        </section> : null}
        {results.report ? <section className="fba-capacity-report" aria-label={copy.report}>
          <DocumentViewer key={`${active.id}:${results.report}`} file={{ session_id: active.session_id, kind: "workspace", path: results.report }}
            name="report.html" state={readingState(active.session_id, `fba-capacity:${active.id}`)} />
        </section> : <p className="workbench-note">{results.workbooks.length ? copy.noReport : copy.noOutput}</p>}
      </> : null}
    </article> : <p className="fba-capacity-empty">{copy.noRuns}</p>}
    </div>
    </div>
  </section>;
}
