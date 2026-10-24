import type { ReactNode } from "react";
import type { DashboardSection } from "./navigation";

// A shared 24-unit drawing grid; motion targets are semantic parts of each glyph.
const glyphs: Record<DashboardSection, ReactNode> = {
  home: <>
    <path d="m4 10 8-6.5 8 6.5v8.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />
    <path className="navigation-icon-home-door" d="M9.5 20.5V14h5v6.5" />
  </>,
  sessions: <>
    <path d="M4 6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9L4 21Z" />
    <path className="navigation-icon-reply" d="M8 10.5h8" />
  </>,
  workbench: <>
    <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
    <path className="navigation-icon-work-panel" d="M9 5v15" />
  </>,
  automations: <>
    <circle cx="12" cy="12" r="8.5" />
    <path className="navigation-icon-clock-hand" d="M12 7v5l3.5 2" />
  </>,
  capabilities: <>
    <rect x="4" y="4" width="6" height="16" rx="2" />
    <rect className="navigation-icon-module" x="14" y="4" width="6" height="6" rx="2" />
    <rect x="14" y="14" width="6" height="6" rx="2" />
  </>,
  activity: <>
    <path d="M5 20V13M12 20V4" />
    <path className="navigation-icon-activity-bar" d="M19 20V9" />
  </>,
};

export function NavigationIcon({ section }: { section: DashboardSection }) {
  return <svg className={`navigation-icon navigation-icon-${section}`} viewBox="0 0 24 24"
    width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <g className="navigation-icon-glyph">{glyphs[section]}</g>
  </svg>;
}
