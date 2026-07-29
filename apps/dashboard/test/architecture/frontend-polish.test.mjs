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
  const collapsedRule = styles.match(
    /\.app-sidebar\.collapsed \.sidebar-status-card\s*\{([\s\S]*?)\}/,
  )?.[1] || "";
  assert.doesNotMatch(collapsedRule, /margin-top:/);
});

test("sessions persist in the application sidebar with title-only rows", () => {
  assert.match(styles, /container-name:\s*dashboard-main/);
  assert.equal((main.match(/<SessionsIndex/g) || []).length, 1);
  assert.match(main, /const sessionsQuery = useSessionsInfiniteQuery\(debouncedQuery\);/);
  assert.match(main, /\{sessionSidebarExpanded \? \(/);
  assert.doesNotMatch(main, /activeSection === "sessions" && sessionSidebarExpanded/);
  assert.match(main, /className="sidebar-session-section"/);
  assert.match(main, /selectedSessionId=\{activeSection === "sessions" \? selectedSessionId : ""\}/);
  assert.doesNotMatch(main, /compactSessionLayout|sessionSidebarOverlayOpen|sessionSidebarDialogOpen/);
  assert.doesNotMatch(styles, /session-sidebar-scrim|session-sidebar-overlay-open/);
  assert.doesNotMatch(sessions, /className="session-meta-line"/);
  assert.match(sessions, /<MessageCircle aria-hidden="true" className="session-index-icon" size=\{13\} \/>/);
  assert.match(sessions, /aria-label=\{sessionTitle\}/);
  assert.match(sessions, /title=\{sessionTitle\}/);

  const searchToggle = main.slice(
    main.indexOf("function handleSessionSearchToggle()"),
    main.indexOf("function handleSidebarToggle()"),
  );
  assert.match(searchToggle, /setSidebarCollapsed\(false\)/);
  assert.doesNotMatch(searchToggle, /pushDashboardRoute|setActiveSection/);

  assert.match(styles, /\.tab-list\s*\{[^}]*gap:\s*1px;/s);
  assert.match(styles, /\.tab\s*\{[^}]*min-height:\s*34px;[^}]*padding:\s*5px 8px;/s);
  assert.match(styles, /\.sidebar-session-section\s*\{[^}]*margin-top:\s*8px;[^}]*padding-top:\s*8px;/s);
  assert.match(styles, /\.session-index-heading\s*\{[^}]*color:\s*color-mix\([^;]+68%, transparent\);[^}]*font-weight:\s*500;/s);
  assert.match(styles, /\.sidebar-session-section \.session-index-list\s*\{[^}]*gap:\s*1px;/s);
  assert.match(styles, /\.sidebar-session-section \.session-index-item\s*\{[^}]*grid-template-columns:\s*14px minmax\(0, 1fr\);[^}]*padding:\s*5\.5px 8px;/s);
  assert.match(styles, /\.sidebar-session-section \.session-index-item \.primary-cell\s*\{[^}]*font-size:\s*0\.9375rem;/s);
  assert.doesNotMatch(main, /sessions-split/);
  assert.doesNotMatch(styles, /\.sessions-split/);
  assert.match(main, /activeSection === "sessions";?\s*$/m);
  assert.doesNotMatch(styles, /\.main-header\.tab-home \.main-title h2::before/);
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
