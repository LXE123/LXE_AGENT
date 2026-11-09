import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { TEAM_SKILLS_URL } from "@lxe/desktop-protocol/team-skills";
import { useUiText } from "../../shared/i18n";

export function TeamSkillsWorkbench({ onBack }: { onBack: () => void }) {
  const t = useUiText(), copy = t.workbenchIndex.tools.teamSkills;
  const viewport = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const prepare = window.lxe?.desktop?.prepareTeamSkillsView;

  useEffect(() => {
    const element = viewport.current;
    if (!element || !prepare) return;
    let active = true;
    const guest = document.createElement("webview");
    // Own the guest in a local document. Removing that document releases the
    // guest and its frame together when leaving the workbench (Electron 43).
    const frame = document.createElement("iframe");
    frame.title = copy.name;
    setError("");
    setLoading(true);
    const fail = (message: string) => {
      if (!active) return;
      frame.remove();
      setLoading(false);
      setError(message);
    };
    guest.addEventListener("did-stop-loading", () => { if (active) setLoading(false); });
    guest.addEventListener("did-fail-load", event => {
      const { isMainFrame, errorCode, errorDescription } = event as Event & {
        isMainFrame: boolean; errorCode: number; errorDescription: string;
      };
      if (isMainFrame && errorCode !== -3) fail(`${errorDescription} (${errorCode})`);
    });
    guest.addEventListener("render-process-gone", event => fail((event as Event & { details: { reason: string } }).details.reason));
    void prepare().then(src => {
      if (!active) return;
      guest.setAttribute("src", src);
      element.appendChild(frame);
      const body = frame.contentDocument!.body;
      body.style.margin = "0";
      guest.style.height = "100vh";
      body.appendChild(guest);
    }).catch(cause => fail(cause instanceof Error ? cause.message : String(cause)));
    return () => { active = false; frame.remove(); };
  }, [attempt, prepare, copy.name]);

  return <section className="team-skills-page" aria-label={copy.name}>
    <header className="team-skills-toolbar">
      <button className="workbench-back" type="button" onClick={onBack}><ArrowLeft size={15} />{t.workbenchIndex.back}</button>
      <h1>{copy.name}</h1>
      {prepare && loading ? <span role="status">{t.common.loading}…</span> : null}
    </header>
    <div className="team-skills-viewport" ref={viewport}>
      {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(v => v + 1)}>{copy.retry}</button></div> : null}
      {!prepare || error ? <a href={TEAM_SKILLS_URL} target="_blank" rel="noopener noreferrer">{copy.openInBrowser}</a> : null}
    </div>
  </section>;
}
