import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TEAM_SKILLS_URL } from "@lxe/desktop-protocol/team-skills";
import { useUiText } from "../../shared/i18n";
import "./theme.css";

export function TeamSkillsPage({ visible }: { visible: boolean }) {
  const t = useUiText(), copy = t.teamSkills;
  const viewport = useRef<HTMLDivElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [mountSrc, setMountSrc] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const previousAttempt = useRef(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const control = window.lxe?.desktop?.teamSkillsView;

  useEffect(() => {
    if (!visible || !control) { setConfirmed(false); return; }
    let current = true;
    const retry = previousAttempt.current !== attempt;
    previousAttempt.current = attempt;
    void control(retry ? "retry" : "show").then(src => {
      if (current) { setMountSrc(src); setConfirmed(true); }
    }).catch(cause => {
      if (current) { setLoading(false); setError(String(cause)); }
    });
    return () => {
      current = false;
      void control("hide").catch(cause => console.error("Failed to hide team skills", cause));
    };
  }, [visible, control, attempt]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element || !mountSrc) return;
    const frame = document.createElement("iframe");
    frame.title = element.getAttribute("aria-label") ?? "";
    element.appendChild(frame);
    const body = frame.contentDocument!.body;
    const guest = document.createElement("webview");
    const loaded = () => setLoading(false);
    const fail = (message: string) => {
      setLoading(false);
      setError(message);
    };
    const failed = (event: Event) => {
      const { isMainFrame, errorCode, errorDescription } = event as Event & {
        isMainFrame: boolean; errorCode: number; errorDescription: string;
      };
      if (isMainFrame && errorCode !== -3) fail(`${errorDescription} (${errorCode})`);
    };
    const gone = (event: Event) => fail((event as Event & { details: { reason: string } }).details.reason);
    guest.addEventListener("did-stop-loading", loaded);
    guest.addEventListener("did-fail-load", failed);
    guest.addEventListener("render-process-gone", gone);
    setError("");
    setLoading(true);
    body.style.margin = "0";
    guest.style.height = "100vh";
    guest.setAttribute("allowpopups", "");
    guest.setAttribute("src", mountSrc);
    body.appendChild(guest);
    return () => {
      guest.removeEventListener("did-stop-loading", loaded);
      guest.removeEventListener("did-fail-load", failed);
      guest.removeEventListener("render-process-gone", gone);
      // Release the enclosing document together with its Electron guest.
      frame.remove();
    };
  }, [mountSrc]);

  if (!visible && !mountSrc) return null;

  return <section className="team-skills-page" hidden={!visible} aria-label={copy.name}>
    <div className="team-skills-viewport" ref={viewport} aria-label={copy.name} data-show-page={confirmed && !error}>
      {control && loading ? <span className="team-skills-loading" role="status">{t.common.loading}…</span> : null}
      {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(v => v + 1)}>{copy.retry}</button></div> : null}
      {!control || error ? <a href={TEAM_SKILLS_URL} target="_blank" rel="noopener noreferrer">{copy.openInBrowser}</a> : null}
    </div>
  </section>;
}
