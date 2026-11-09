import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { TEAM_SKILLS_URL } from "@lxe/desktop-protocol/team-skills";
import { useUiText } from "../../shared/i18n";
import { observeNativeViewport } from "../../shared/native-viewport";

export function TeamSkillsWorkbench({ onBack, status }: { onBack: () => void; status: ReactNode }) {
  const t = useUiText(), copy = t.workbenchIndex.tools.teamSkills;
  const viewport = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const bridge = window.lxe?.desktop?.teamSkillsView;

  useEffect(() => {
    const element = viewport.current;
    if (!element || !bridge) return;
    let active = true;
    let stopObserving: (() => void) | undefined;
    setError("");
    setLoading(true);
    const fail = (cause: unknown) => {
      if (!active) return;
      stopObserving?.();
      void bridge({ action: "close" }).catch(() => {});
      setLoading(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    };
    const opened = bridge({ action: "open" });
    stopObserving = observeNativeViewport(element, bounds => {
      void bridge({ action: "present", bounds }).catch(fail);
    });
    void opened.then(() => { if (active) setLoading(false); }).catch(fail);
    return () => {
      active = false;
      stopObserving?.();
      void bridge({ action: "close" }).catch(() => {});
    };
  }, [attempt, bridge]);

  return <section className="team-skills-page" aria-label={copy.name}>
    <header className="team-skills-toolbar">
      <button className="workbench-back" type="button" onClick={onBack}><ArrowLeft size={15} />{t.workbenchIndex.back}</button>
      <h1>{copy.name}</h1>
      {bridge && loading ? <span role="status">{t.common.loading}…</span> : null}
      {status}
    </header>
    <div className="team-skills-viewport" ref={viewport}>
      {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(v => v + 1)}>{copy.retry}</button></div> : null}
      {!bridge || error ? <a href={TEAM_SKILLS_URL} target="_blank" rel="noopener noreferrer">{copy.openInBrowser}</a> : null}
    </div>
  </section>;
}
