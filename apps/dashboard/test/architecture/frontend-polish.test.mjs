import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../../src");
const readSource = (relativePath) => readFileSync(path.join(sourceDir, relativePath), "utf8");

const main = readSource("main.tsx");
const shell = readSource("desktop/shell.tsx");
const details = readSource("features/details/view.tsx");
const integrations = readSource("features/integrations/view.tsx");
const models = readSource("features/models/view.tsx");
const sessions = readSource("features/sessions/view.tsx");
const sidebar = readSource("shared/use-three-state-sidebar.ts");
const stats = readSource("features/stats/view.tsx");
const styles = readSource("styles.css");
const dialogFocus = readSource("shared/ui/use-dialog-focus.ts");

test("status and settings have one sidebar entry and no floating duplicate", () => {
  assert.match(main, /t\.sidebar\.statusAndSettings/);
  assert.match(main, /onClick=\{\(\) => onOpenDesktopSettings\?\.\("status"\)\}/);
  const statusCardStart = main.indexOf('className="sidebar-status-card"');
  const statusCard = main.slice(statusCardStart, main.indexOf("</button>", statusCardStart));
  assert.doesNotMatch(statusCard, /currentModelQuery|sidebar-status-meta/);
  assert.doesNotMatch(main, /DashboardStatusModal|dashboardStatusOpen|statusSessionsQuery/);
  assert.doesNotMatch(shell, /desktop-status-button/);
  assert.doesNotMatch(styles, /\.desktop-status-button/);

  const statusCardRule = styles.match(/\.sidebar-status-card\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(statusCardRule, /flex:\s*0 0 auto/);
  assert.match(statusCardRule, /margin-top:\s*auto/);
  assert.doesNotMatch(styles, /\.app-sidebar\.collapsed \.sidebar-status-card/);
});

test("sessions persist in the application sidebar with title-only rows", () => {
  assert.match(styles, /container-name:\s*dashboard-main/);
  assert.equal((main.match(/<SessionsIndex/g) || []).length, 1);
  assert.match(main, /const sessionsQuery = useSessionsInfiniteQuery\(debouncedQuery\);/);
  assert.match(main, /const sidebarMode = sidebar\.mode;/);
  assert.doesNotMatch(main, /activeSection === "sessions" && sessionSidebarExpanded/);
  assert.match(main, /className="sidebar-session-section"/);
  assert.match(main, /selectedSessionId=\{activeSection === "sessions" \? selectedSessionId : ""\}/);
  assert.doesNotMatch(main, /compactSessionLayout|sessionSidebarOverlayOpen|sessionSidebarDialogOpen/);
  assert.doesNotMatch(styles, /session-sidebar-scrim|session-sidebar-overlay-open/);
  assert.match(main, /onTransientInteractionChange=\{sidebar\.onTransientInteractionChange\}/);
  assert.match(main, /visible=\{sidebarVisible\}/);
  assert.match(sessions, /const transientInteractionActive = Boolean\(menu\);/);
  assert.match(sessions, /onTransientInteractionChange\?\.\(transientInteractionActive\)/);
  assert.match(sessions, /if \(visible\) return;\s*closeMenu\(false\);/);
  assert.doesNotMatch(sessions, /className="session-meta-line"/);
  // A bare marker, not an icon: the row already says "conversation".
  assert.match(sessions, /<span aria-hidden="true" className="session-index-icon" \/>/);
  assert.doesNotMatch(sessions, /MessageCircle/);
  assert.match(styles, /\.session-index-open \{[^}]*grid-template-columns:\s*5px minmax\(0, 1fr\);/s);
  assert.match(sessions, /aria-label=\{sessionTitle\}/);
  assert.match(sessions, /title=\{sessionTitle\}/);
  assert.doesNotMatch(sessions, /pill sessions-loading-pill/);
  assert.match(sessions, /loadingMore \? \([\s\S]*?sessions-load-more-indicator[\s\S]*?LoaderCircle/);
  assert.match(main, /initialLoading=\{sessionsQuery\.isPending && !sessions\.items\.length\}/);
  assert.match(main, /loadingMore=\{sessionsQuery\.isFetchingNextPage\}/);
  assert.doesNotMatch(main, /loading=\{sessionsQuery\.isFetching\}/);

  const searchToggle = main.slice(
    main.indexOf("function handleSessionSearchToggle()"),
    main.indexOf("// Keep the focused conversation populated by default."),
  );
  assert.match(searchToggle, /sidebar\.openForSearch\(\)/);
  assert.match(sidebar, /if \(collapsed && !peekOpen\) setPeekOpen\(true\);/);
  assert.doesNotMatch(searchToggle, /pushDashboardRoute|setActiveSection/);

  assert.match(styles, /\.tab-list\s*\{[^}]*gap:\s*1px;/s);
  assert.match(styles, /\.tab\s*\{[^}]*min-height:\s*34px;[^}]*padding:\s*5px 8px;/s);
  assert.match(styles, /\.tab\s*\{[^}]*color:\s*var\(--sidebar-ink, var\(--text-strong\)\);/s);
  assert.match(styles, /\.tab\.active\s*\{[^}]*color:\s*var\(--sidebar-ink, var\(--text-strong\)\);/s);
  assert.match(styles, /\.sidebar-session-section\s*\{[^}]*margin-top:\s*8px;[^}]*padding-top:\s*8px;/s);
  assert.match(styles, /\.session-index-heading\s*\{[^}]*color:\s*color-mix\([^;]+68%, transparent\);[^}]*font-weight:\s*500;/s);
  assert.match(styles, /\.sidebar-session-section \.session-index-list\s*\{[^}]*gap:\s*1px;/s);
  assert.match(styles, /\.sidebar-session-section \.session-index-item\s*\{[^}]*display:\s*block;/s);
  assert.match(styles, /\.sidebar-session-section \.session-index-open\s*\{[^}]*width:\s*100%;[^}]*padding:\s*5\.5px 8px;/s);
  assert.match(styles, /\.sidebar-session-section \.session-index-actions\s*\{[^}]*position:\s*absolute;[^}]*right:\s*4px;/s);
  assert.match(styles, /\.sidebar-session-section \.session-index-item \.primary-cell\s*\{[^}]*font-size:\s*0\.8375rem;[^}]*text-overflow:\s*clip;[^}]*mask-image:\s*linear-gradient\(to right,/s);
  assert.match(styles, /\.sidebar-session-section \.session-index-list\s*\{[^}]*margin-right:\s*-6px;[^}]*overflow-y:\s*scroll;[^}]*scrollbar-gutter:\s*stable;[^}]*scrollbar-width:\s*thin;/s);
  assert.doesNotMatch(main, /sessions-split/);
  assert.doesNotMatch(styles, /\.sessions-split/);
  assert.match(main, /activeSection === "sessions";?\s*$/m);
  assert.doesNotMatch(styles, /\.main-header\.tab-home \.main-title h2::before/);
});

test("session rows expose an accessible pinned and destructive action menu", () => {
  assert.match(sessions, /createPortal\(/);
  assert.match(sessions, /aria-haspopup="menu"/);
  assert.match(sessions, /role="menu"/);
  assert.match(sessions, /role="menuitem"/);
  assert.match(sessions, /event\.key === "Escape"/);
  assert.match(sessions, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(sessions, /t\.sessions\.deleteNote/);
  assert.match(sessions, /useDialogFocus<HTMLElement>\(true, onCancel\)/);
  assert.match(styles, /\.session-index-actions\s*\{[^}]*opacity:\s*0;/s);
  assert.match(styles, /\.session-index-item:hover \.session-index-actions,[\s\S]*?opacity:\s*1;/s);
  assert.match(styles, /\.session-actions-menu\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*180;/s);
  assert.match(styles, /\.session-actions-menu button\.danger\s*\{[^}]*color:/s);
});

test("statistics and connections use progressive disclosure instead of card grids", () => {
  assert.match(stats, /className="usage-summary-strip"/);
  assert.equal((stats.match(/<details className="usage-section usage-breakdown">/g) || []).length, 3);
  assert.doesNotMatch(stats, /className="usage-cards"|className=\{card\.tone \? `usage-card/);
  assert.match(integrations, /className="connection-list"/);
  assert.match(integrations, /className="connection-row"/);
  assert.doesNotMatch(integrations, /connector-card|connectors-grid/);
});

test("dialogs trap focus, close with Escape, and avoid native confirmations", () => {
  assert.match(dialogFocus, /event\.key === "Escape"/);
  assert.match(dialogFocus, /event\.key !== "Tab"/);
  assert.match(dialogFocus, /previouslyFocused\?\.focus\(\)/);
  assert.match(shell, /useDialogFocus<HTMLFormElement>\(settingsOpen, closeSettings\)/);
  assert.match(details, /useDialogFocus<HTMLElement>\(Boolean\(target\), onClose\)/);
  assert.match(shell, /role="dialog"/);
  assert.doesNotMatch(shell, /window\.confirm/);
  assert.match(shell, /aria-live="polite"/);
  assert.match(shell, /role="alert"/);
});

test("model cards keep exact token values while using compact visible labels", () => {
  assert.match(models, /formatCompactNumber/);
  assert.match(models, /aria-label=\{exactValue\}/);
  assert.match(models, /title=\{exactValue\}/);
  assert.match(styles, /container-name:\s*model-card/);
  assert.match(styles, /container-type:\s*inline-size/);
  assert.match(
    styles,
    /@container model-card \(max-width:\s*340px\)[\s\S]*?\.model-select-row\s*\{[\s\S]*?grid-template-columns:\s*1fr/
  );

  const metricRule = styles.match(/\.compact-metrics dd\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.doesNotMatch(metricRule, /text-overflow/);
  assert.doesNotMatch(metricRule, /overflow:\s*hidden/);
});
