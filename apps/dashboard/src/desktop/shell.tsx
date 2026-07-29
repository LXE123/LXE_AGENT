import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Cloud,
  ExternalLink,
  Feather,
  FileKey2,
  FileUp,
  FolderOpen,
  Globe,
  Languages,
  Palette,
  RotateCcw,
  ScrollText,
  Settings2,
  ShieldCheck,
  Store,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  DesktopConfigImportPreview,
  DesktopCloudDestination,
  DesktopCloudEnrollmentSelection,
  DesktopCloudState,
  DesktopHealth,
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopSetupInput,
  DesktopSetupState,
  DesktopZiniaoVersion,
} from "@lxe/desktop-protocol";
import { BrandMark } from "../shared/ui/brand-mark";
import { useUiText } from "../shared/i18n";
import type { Language, UiText } from "../shared/i18n";
import type { DashboardFontSize } from "../shared/appearance";
import { LanguageSwitch } from "../shared/ui/language-switch";
import { useDialogFocus } from "../shared/ui/use-dialog-focus";
import {
  configImportSuccessMessage,
  desktopProgressNotice,
  desktopSuccessNotice,
  type DesktopNoticeState,
} from "./notice-model";
import {
  desktopSettingsForm,
  desktopLoggingSinkView,
  desktopSettingsSectionIsDirty,
  desktopSettingsSectionStatus,
  type DesktopSettingsFormValue,
  type DesktopSettingsSection,
  type EditableDesktopSettingsSection,
} from "./settings-model";

type Provider = DesktopSetupInput["provider"];
type IntegrationName = "ziniao" | "mabang" | "feishu";
type SetupForm = DesktopSettingsFormValue;
type DesktopConfirmation =
  | { kind: "diagnostic" }
  | { kind: "clear-integration"; integration: IntegrationName; label: string };
const setupForm = desktopSettingsForm;

const FONT_SIZE_VALUES: ReadonlyArray<DashboardFontSize> = ["small", "standard", "large"];

const fontSizeLabel = (text: UiText["desktop"], fontSize: DashboardFontSize): string =>
  text.fontSizeOptions[fontSize].label;

const integrationStatusClass = (managed: boolean, configured: boolean): string =>
  `desktop-integration-status ${configured ? "configured" : managed ? "incomplete" : "optional"}`;

const hasText = (...values: string[]): boolean => values.some((value) => value.trim().length > 0);

function IntegrationIssues({ issues }: { issues: string[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="desktop-integration-issues">
      {issues.map((issue) => <li key={issue}>{issue}</li>)}
    </ul>
  );
}

function LoggingSinkCard({
  label,
  status,
}: {
  label: string;
  status: DesktopHealth["logging"]["agent_cli"];
}) {
  const t = useUiText();
  const view = desktopLoggingSinkView(t.desktop, status);
  return (
    <div className={`desktop-logging-sink state-${view.tone}`}>
      <div>
        <span>{label}</span>
        <strong>{view.label}</strong>
      </div>
      {status?.file_path ? <code title={status.file_path}>{status.file_path}</code> : null}
      {status?.last_error ? <p>{status.last_error}</p> : null}
    </div>
  );
}

function DesktopSettingsNavigation({
  activeSection,
  baseline,
  form,
  health,
  fontSize,
  language,
  setup,
  cloud,
  showStatus,
  onLanguageChange,
  onSelect,
  onSelectConfigImport,
  configurationBusy,
}: {
  activeSection: DesktopSettingsSection;
  baseline: SetupForm;
  form: SetupForm;
  health: DesktopHealth | null;
  fontSize: DashboardFontSize;
  language: Language;
  setup: DesktopSetupState;
  cloud: DesktopCloudState;
  showStatus: boolean;
  onLanguageChange: (language: Language) => void;
  onSelect: (section: DesktopSettingsSection) => void;
  onSelectConfigImport: () => void;
  configurationBusy: boolean;
}) {
  const t = useUiText();
  const item = (section: DesktopSettingsSection, label: string, status: string, Icon: LucideIcon) => {
    const dirty = desktopSettingsSectionIsDirty(section, form, baseline);
    const active = activeSection === section;
    return (
      <button
        aria-current={active ? "page" : undefined}
        className={`desktop-settings-nav-item${active ? " active" : ""}`}
        key={section}
        onClick={() => onSelect(section)}
        type="button"
      >
        <Icon aria-hidden size={15} />
        <span>
          <strong>{label}</strong>
          <small>{status}</small>
        </span>
        {dirty ? (
          <i aria-label={t.desktop.unsavedChanges} className="desktop-settings-dirty-dot" title={t.desktop.unsavedChanges} />
        ) : null}
      </button>
    );
  };

  return (
    <nav aria-label={t.desktop.menuAria} className="desktop-settings-nav">
      <div className="desktop-settings-nav-list">
        {showStatus ? item("status", t.desktop.sectionTitles.status, t.home.componentStates[health?.gateway ?? "starting"], Activity) : null}
        {item("appearance", t.desktop.sectionTitles.appearance, t.desktop.fontSizeStatus(fontSizeLabel(t.desktop, fontSize)), Palette)}
        {item("cloud", t.desktop.sectionTitles.cloud, t.desktop.cloudStates[cloud.connection], Cloud)}
        {item("base", t.desktop.sectionTitles.base, desktopSettingsSectionStatus(t.desktop, "base", setup), Settings2)}
        <p className="desktop-settings-nav-group">{t.desktop.integrationsGroup}</p>
        {item("ziniao", t.desktop.sectionTitles.ziniao, desktopSettingsSectionStatus(t.desktop, "ziniao", setup), Globe)}
        {item("mabang", t.desktop.sectionTitles.mabang, desktopSettingsSectionStatus(t.desktop, "mabang", setup), Store)}
        {item("feishu", t.desktop.sectionTitles.feishu, desktopSettingsSectionStatus(t.desktop, "feishu", setup), Feather)}
        {item("logging", t.desktop.sectionTitles.logging, desktopSettingsSectionStatus(t.desktop, "logging", setup), ScrollText)}
      </div>
      <div className="desktop-settings-nav-footer">
        <div className="desktop-settings-language">
          <span><Languages aria-hidden size={15} />{t.desktop.interfaceLanguage}</span>
          <LanguageSwitch language={language} onLanguageChange={onLanguageChange} />
        </div>
        <button
          className="desktop-settings-import-button"
          disabled={configurationBusy}
          onClick={onSelectConfigImport}
          type="button"
        >
          <FileUp size={15} />
          <span><strong>{t.desktop.importEnv}</strong><small>{t.desktop.importEnvHint}</small></span>
        </button>
      </div>
    </nav>
  );
}

function DesktopNoticeMessage({
  className,
  notice,
  onDismiss,
}: {
  className: string;
  notice: DesktopNoticeState;
  onDismiss: () => void;
}) {
  const t = useUiText();
  return (
    <div aria-live="polite" className={`${className} desktop-notice-message`} role="status">
      <span>{notice.message}</span>
      {notice.dismissible ? (
        <button aria-label={t.desktop.closeNotice} onClick={onDismiss} title={t.desktop.closeNotice} type="button">
          <X aria-hidden size={14} />
        </button>
      ) : null}
    </div>
  );
}

function DesktopCloudPanel({
  activating,
  cloud,
  enrollment,
  headingRef,
  password,
  onActivate,
  onOpenDestination,
  onPasswordChange,
  onRetry,
  onSelect,
}: {
  activating: boolean;
  cloud: DesktopCloudState;
  enrollment: DesktopCloudEnrollmentSelection | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  password: string;
  onActivate: () => void;
  onOpenDestination: (destination: DesktopCloudDestination) => void;
  onPasswordChange: (value: string) => void;
  onRetry: () => void;
  onSelect: () => void;
}) {
  const t = useUiText();
  const connected = cloud.connection === "connected";
  const supported = cloud.connection !== "unsupported";
  const shortcuts: Array<{
    admin?: boolean;
    description: string;
    destination: DesktopCloudDestination;
    icon: LucideIcon;
    label: string;
  }> = [
    {
      destination: "agent_dashboard",
      icon: Activity,
      label: t.desktop.cloud.shortcuts.agentTitle,
      description: t.desktop.cloud.shortcuts.agentDescription,
    },
    {
      destination: "erp_dashboard",
      icon: Store,
      label: t.desktop.cloud.shortcuts.erpTitle,
      description: t.desktop.cloud.shortcuts.erpDescription,
    },
    {
      admin: true,
      destination: "admin_dashboard",
      icon: ShieldCheck,
      label: t.desktop.cloud.shortcuts.adminTitle,
      description: t.desktop.cloud.shortcuts.adminDescription,
    },
  ];
  return (
    <section className="desktop-settings-section desktop-cloud-panel">
      <DesktopSectionHeading
        badge={connected
          ? t.desktop.cloud.connectedBadge
          : cloud.configured
            ? t.desktop.cloud.configuredBadge
            : supported
              ? t.desktop.cloud.unconfiguredBadge
              : t.desktop.cloud.unsupportedBadge}
        badgeClassName={connected ? "desktop-cloud-badge connected" : "desktop-cloud-badge"}
        description={t.desktop.cloud.description}
        headingRef={headingRef}
        title={t.desktop.sectionTitles.cloud}
      />
      {cloud.configured ? (
        <div className="desktop-cloud-identity">
          <ShieldCheck aria-hidden size={20} />
          <div><strong>{cloud.device_name}</strong><span>{cloud.vpn_ip}</span></div>
        </div>
      ) : null}
      {cloud.configured ? (
        <div className={`desktop-cloud-permission ${cloud.permission_status}`}>
          <div>
            <strong>{t.desktop.cloud.permission.title}</strong>
            <span>{t.desktop.cloud.permission.status[cloud.permission_status]}</span>
          </div>
          <dl>
            <div>
              <dt>{t.desktop.cloud.permission.profile}</dt>
              <dd>{cloud.permission_profile
                ? t.desktop.cloud.permission.profiles[cloud.permission_profile]
                : t.desktop.cloud.permission.unassigned}</dd>
            </div>
            <div>
              <dt>{t.desktop.cloud.permission.version}</dt>
              <dd>{cloud.permission_version > 0 ? `v${cloud.permission_version}` : "—"}</dd>
            </div>
          </dl>
        </div>
      ) : null}
      {!supported ? (
        <p className="desktop-form-hint">{t.desktop.cloud.unsupportedHint}</p>
      ) : !cloud.configured ? (
        <div className="desktop-cloud-activation">
          <button className="desktop-path-button" disabled={activating} onClick={onSelect} type="button">
            <FileKey2 size={17} />
            {enrollment?.file_name || t.desktop.cloud.selectEnrollment}
          </button>
          <label>
            <span>{t.desktop.cloud.oneTimePassword}</span>
            <input
              autoComplete="off"
              disabled={activating}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder={t.desktop.cloud.passwordPlaceholder}
              type="password"
              value={password}
            />
          </label>
          <button
            className="desktop-primary-button desktop-cloud-activate"
            disabled={activating || !enrollment || password.trim().length < 12}
            onClick={onActivate}
            type="button"
          >
            <Cloud size={17} />
            {activating ? t.desktop.cloud.activating : t.desktop.cloud.activate}
          </button>
        </div>
      ) : null}
      {cloud.configured ? (
        <div className={`desktop-cloud-status ${cloud.connection}`}>
          <span>{connected ? t.desktop.cloud.connected : cloud.last_error || t.desktop.cloud.checking}</span>
          {!connected ? (
            <button disabled={activating} onClick={onRetry} type="button">
              <RotateCcw size={15} />
              {t.desktop.cloud.retry}
            </button>
          ) : null}
        </div>
      ) : cloud.last_error ? <p className="desktop-form-error" role="alert">{cloud.last_error}</p> : null}
      {cloud.configured ? (
        <div className="desktop-cloud-shortcuts">
          <div className="desktop-cloud-shortcuts-heading">
            <div>
              <strong>{t.desktop.cloud.shortcuts.title}</strong>
              <span>{t.desktop.cloud.shortcuts.description}</span>
            </div>
            {!connected ? (
              <span className="desktop-cloud-shortcuts-unavailable">
                {t.desktop.cloud.shortcuts.unavailable}
              </span>
            ) : null}
          </div>
          <div className="desktop-cloud-shortcuts-grid">
            {shortcuts.filter((shortcut) => !shortcut.admin || cloud.is_admin).map((shortcut) => {
              const Icon = shortcut.icon;
              return (
                <button
                  aria-label={`${shortcut.label}: ${shortcut.description}`}
                  disabled={!connected}
                  key={shortcut.destination}
                  onClick={() => onOpenDestination(shortcut.destination)}
                  type="button"
                >
                  <Icon aria-hidden size={19} />
                  <span className="desktop-cloud-shortcut-copy">
                    <strong>
                      {shortcut.label}
                      {shortcut.admin ? (
                        <span className="desktop-cloud-admin-badge">
                          {t.desktop.cloud.shortcuts.adminBadge}
                        </span>
                      ) : null}
                    </strong>
                    <span>{shortcut.description}</span>
                  </span>
                  <ExternalLink aria-hidden className="desktop-cloud-shortcut-open" size={15} />
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DesktopSectionHeading({
  badge,
  badgeClassName,
  description,
  headingRef,
  title,
}: {
  badge?: string;
  badgeClassName?: string;
  description: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  title: string;
}) {
  return (
    <div className="desktop-section-heading">
      <div>
        <h3 ref={headingRef} tabIndex={-1}>{title}</h3>
        <p>{description}</p>
      </div>
      {badge ? <span className={badgeClassName}>{badge}</span> : null}
    </div>
  );
}

function DesktopStatusPanel({
  health,
  headingRef,
  restarting,
  onRestart,
}: {
  health: DesktopHealth | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  restarting: boolean;
  onRestart: () => void;
}) {
  const t = useUiText();
  const hasHealthError = health
    ? [health.gateway, health.agent_cli, health.lxeskill].includes("error")
    : false;
  return (
    <section className="desktop-settings-section desktop-status-panel">
      <DesktopSectionHeading
        description={t.desktop.status.description}
        headingRef={headingRef}
        title={t.desktop.sectionTitles.status}
      />
      <div className="desktop-health-grid">
        {([
          ["Gateway", health?.gateway],
          ["agent-cli", health?.agent_cli],
          ["lxeskill", health?.lxeskill],
        ] as const).map(([label, value]) => (
          <div className={`desktop-health-card state-${value ?? "stopped"}`} key={label}>
            <span>{label}</span>
            <strong><i aria-hidden="true" className="desktop-health-dot" />{t.home.componentStates[value ?? "stopped"]}</strong>
          </div>
        ))}
      </div>
      {health?.message && hasHealthError ? <p className="desktop-health-message">{health.message}</p> : null}
      <div className="desktop-maintenance-panel">
        <div className="desktop-maintenance-heading">
          <div>
            <strong>{t.desktop.status.maintenance}</strong>
            <span>{t.desktop.status.maintenanceHint}</span>
          </div>
          <button className="desktop-restart-button" disabled={restarting} onClick={onRestart} type="button">
            <RotateCcw size={15} />
            {restarting ? t.desktop.status.restarting : t.desktop.status.restart}
          </button>
        </div>
        {health ? (
          <details className="desktop-diagnostics">
            <summary>{t.desktop.status.directories}</summary>
            <dl>
              <div><dt>{t.desktop.status.resourceRoot}</dt><dd>{health.resource_root}</dd></div>
              <div><dt>{t.desktop.status.dataRoot}</dt><dd>{health.data_root}</dd></div>
              <div><dt>{t.desktop.status.workspaceRoot}</dt><dd>{health.workspace_root}</dd></div>
            </dl>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function DesktopAppearancePanel({
  fontSize,
  headingRef,
  onFontSizeChange,
}: {
  fontSize: DashboardFontSize;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onFontSizeChange: (fontSize: DashboardFontSize) => void;
}) {
  const t = useUiText();
  return (
    <section className="desktop-settings-section desktop-appearance-panel">
      <DesktopSectionHeading
        badge={fontSizeLabel(t.desktop, fontSize)}
        badgeClassName="desktop-appearance-badge"
        description={t.desktop.appearance.description}
        headingRef={headingRef}
        title={t.desktop.sectionTitles.appearance}
      />
      <div aria-label={t.desktop.appearance.fontSizeAria} className="desktop-appearance-options" role="group">
        {FONT_SIZE_VALUES.map((value) => {
          const option = t.desktop.fontSizeOptions[value];
          return (
            <button
              aria-pressed={fontSize === value}
              className={`desktop-appearance-option${fontSize === value ? " active" : ""}`}
              key={value}
              onClick={() => onFontSizeChange(value)}
              type="button"
            >
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function DesktopSettingsForm({
  activeSection,
  form,
  health,
  headingRef,
  setup,
  platform,
  requireKey,
  onChange,
  onSelectWorkspace,
  onSelectZiniaoApp,
  onSelectZiniaoWebDriverDirectory,
  onOpenLogsDirectory,
  onClearIntegration,
}: {
  activeSection: EditableDesktopSettingsSection;
  form: SetupForm;
  health: DesktopHealth;
  headingRef: RefObject<HTMLHeadingElement | null>;
  setup: DesktopSetupState;
  platform: "win32" | "darwin" | "linux";
  requireKey: boolean;
  onChange: (patch: Partial<SetupForm>) => void;
  onSelectWorkspace: () => void;
  onSelectZiniaoApp: () => void;
  onSelectZiniaoWebDriverDirectory: () => void;
  onOpenLogsDirectory: () => void;
  onClearIntegration: (name: IntegrationName) => void;
}) {
  const t = useUiText();
  if (activeSection === "base") {
    return (
      <section className="desktop-settings-section">
        <DesktopSectionHeading
          badge={t.desktop.sectionStatus.required}
          badgeClassName="desktop-required-badge"
          description={t.desktop.base.description}
          headingRef={headingRef}
          title={t.desktop.sectionTitles.base}
        />
        <div className="desktop-field-grid">
          <label>
            <span>{t.desktop.base.provider}</span>
            <select value={form.provider} onChange={(event) => onChange({ provider: event.target.value as Provider, apiKey: "" })}>
              <option value="kimi_coding">Kimi Coding</option>
              <option value="deepseek">DeepSeek</option>
              <option value="glm">GLM</option>
            </select>
          </label>
          <label>
            <span>API Key{requireKey ? t.desktop.base.apiKeySuffixRequired : t.desktop.keepBlankSuffix}</span>
            <input
              autoComplete="new-password"
              onChange={(event) => onChange({ apiKey: event.target.value })}
              placeholder={requireKey ? t.desktop.base.apiKeyPlaceholder : t.desktop.base.apiKeyStoredPlaceholder}
              type="password"
              value={form.apiKey}
            />
          </label>
          <label className="desktop-field-wide">
            <span>{t.desktop.base.workspace}</span>
            <span className="desktop-path-input">
              <input onChange={(event) => onChange({ workspaceRoot: event.target.value })} value={form.workspaceRoot} />
              <button onClick={onSelectWorkspace} title={t.desktop.base.selectFolder} type="button"><FolderOpen size={17} /></button>
            </span>
          </label>
        </div>
      </section>
    );
  }

  if (activeSection === "ziniao") {
    const status = desktopSettingsSectionStatus(t.desktop, "ziniao", setup);
    return (
      <section className="desktop-settings-section">
        <DesktopSectionHeading
          badge={status}
          badgeClassName={integrationStatusClass(setup.ziniao.managed, setup.ziniao.configured)}
          description={t.desktop.ziniao.description}
          headingRef={headingRef}
          title={t.desktop.sectionTitles.ziniao}
        />
        <div className="desktop-integration-fields">
          <IntegrationIssues issues={setup.ziniao.issues} />
          <div className="desktop-field-grid">
            <label>
              <span>{t.desktop.ziniao.company}</span>
              <input
                onChange={(event) => onChange({ ziniaoCompany: event.target.value })}
                placeholder={t.desktop.ziniao.company}
                value={form.ziniaoCompany}
              />
            </label>
            <label>
              <span>{t.desktop.ziniao.account}</span>
              <input
                autoComplete="username"
                onChange={(event) => onChange({ ziniaoUsername: event.target.value })}
                placeholder={t.desktop.ziniao.accountPlaceholder}
                value={form.ziniaoUsername}
              />
            </label>
            <label>
              <span>{t.desktop.ziniao.password}{setup.ziniao.password_configured ? t.desktop.keepBlankSuffix : ""}</span>
              <input
                autoComplete="new-password"
                onChange={(event) => onChange({ ziniaoPassword: event.target.value })}
                placeholder={setup.ziniao.password_configured ? t.desktop.storedPlaceholder : t.desktop.ziniao.passwordPlaceholder}
                type="password"
                value={form.ziniaoPassword}
              />
            </label>
            <label>
              <span>{t.desktop.ziniao.appVersion}</span>
              <select
                disabled={platform === "darwin"}
                onChange={(event) => onChange({ ziniaoVersion: event.target.value as DesktopZiniaoVersion })}
                value={platform === "darwin" ? "v6" : form.ziniaoVersion}
              >
                <option value="v6">v6</option>
                {platform !== "darwin" ? <option value="v5">v5</option> : null}
              </select>
            </label>
            <label className="desktop-field-wide">
              <span>{t.desktop.ziniao.appPath}</span>
              <span className="desktop-path-input">
                <input
                  onChange={(event) => onChange({ ziniaoAppPath: event.target.value })}
                  placeholder={platform === "darwin" ? t.desktop.ziniao.appPathPlaceholderMac : t.desktop.ziniao.appPathPlaceholderWindows}
                  value={form.ziniaoAppPath}
                />
                <button onClick={onSelectZiniaoApp} title={t.desktop.ziniao.selectApp} type="button">
                  <FolderOpen size={17} />
                </button>
              </span>
            </label>
            <label className="desktop-field-wide">
              <span>{t.desktop.ziniao.webdriverPath}</span>
              <span className="desktop-path-input">
                <input
                  onChange={(event) => onChange({ ziniaoWebDriverPath: event.target.value })}
                  placeholder={t.desktop.ziniao.webdriverPlaceholder}
                  value={form.ziniaoWebDriverPath}
                />
                <button onClick={onSelectZiniaoWebDriverDirectory} title={t.desktop.ziniao.selectWebdriver} type="button">
                  <FolderOpen size={17} />
                </button>
              </span>
            </label>
          </div>
          {setup.ziniao.managed ? (
            <button className="desktop-clear-integration" onClick={() => onClearIntegration("ziniao")} type="button">
              <Trash2 size={14} />{t.desktop.clearIntegration}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (activeSection === "mabang") {
    const status = desktopSettingsSectionStatus(t.desktop, "mabang", setup);
    return (
      <section className="desktop-settings-section">
        <DesktopSectionHeading
          badge={status}
          badgeClassName={integrationStatusClass(setup.mabang.managed, setup.mabang.configured)}
          description={t.desktop.mabang.description}
          headingRef={headingRef}
          title={t.desktop.sectionTitles.mabang}
        />
        <div className="desktop-integration-fields">
          <IntegrationIssues issues={setup.mabang.issues} />
          <div className="desktop-field-grid">
            <label>
              <span>{t.desktop.mabang.account}</span>
              <input
                autoComplete="username"
                onChange={(event) => onChange({ mabangAccount: event.target.value })}
                value={form.mabangAccount}
              />
            </label>
            <label>
              <span>{t.desktop.mabang.password}{setup.mabang.password_configured ? t.desktop.keepBlankSuffix : ""}</span>
              <input
                autoComplete="new-password"
                onChange={(event) => onChange({ mabangPassword: event.target.value })}
                placeholder={setup.mabang.password_configured ? t.desktop.storedPlaceholder : t.desktop.mabang.passwordPlaceholder}
                type="password"
                value={form.mabangPassword}
              />
            </label>
          </div>
          {setup.mabang.managed ? (
            <button className="desktop-clear-integration" onClick={() => onClearIntegration("mabang")} type="button">
              <Trash2 size={14} />{t.desktop.clearIntegration}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (activeSection === "feishu") {
    const status = desktopSettingsSectionStatus(t.desktop, "feishu", setup);
    return (
      <section className="desktop-settings-section">
        <DesktopSectionHeading
          badge={status}
          badgeClassName={integrationStatusClass(setup.feishu.managed, setup.feishu.configured)}
          description={t.desktop.feishu.description}
          headingRef={headingRef}
          title={t.desktop.sectionTitles.feishu}
        />
        <div className="desktop-integration-fields">
          <IntegrationIssues issues={setup.feishu.issues} />
          <div className="desktop-field-grid">
            <label>
              <span>App ID</span>
              <input
                autoComplete="off"
                onChange={(event) => onChange({ feishuAppId: event.target.value })}
                value={form.feishuAppId}
              />
            </label>
            <label>
              <span>{t.desktop.feishu.appSecret}{setup.feishu.app_secret_configured ? t.desktop.keepBlankSuffix : ""}</span>
              <input
                autoComplete="new-password"
                onChange={(event) => onChange({ feishuAppSecret: event.target.value })}
                placeholder={setup.feishu.app_secret_configured ? t.desktop.storedPlaceholder : t.desktop.feishu.appSecretPlaceholder}
                type="password"
                value={form.feishuAppSecret}
              />
            </label>
          </div>
          {setup.feishu.managed ? (
            <button className="desktop-clear-integration" onClick={() => onClearIntegration("feishu")} type="button">
              <Trash2 size={14} />{t.desktop.clearIntegration}
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="desktop-settings-section">
      <DesktopSectionHeading
        description={t.desktop.logging.description}
        headingRef={headingRef}
        title={t.desktop.sectionTitles.logging}
      />
      <div className="desktop-field-grid">
        <label>
          <span>{t.desktop.logging.profile}</span>
          <select onChange={(event) => onChange({ logProfile: event.target.value as DesktopLogProfile })} value={form.logProfile}>
            <option value="off">{t.desktop.logProfiles.off}</option>
            <option value="standard">{t.desktop.logProfiles.standard}</option>
            <option value="diagnostic">{t.desktop.logProfiles.diagnostic}</option>
          </select>
        </label>
        <label>
          <span>{t.desktop.logging.retention}</span>
          <select
            disabled={form.logProfile === "off"}
            onChange={(event) => onChange({ logRetentionDays: Number(event.target.value) as DesktopLogRetentionDays })}
            value={form.logRetentionDays}
          >
            {[3, 7, 14, 30].map((days) => <option key={days} value={days}>{t.desktop.logging.retentionDays(String(days))}</option>)}
          </select>
        </label>
      </div>
      {form.logProfile === "diagnostic" ? (
        <div className="desktop-diagnostic-warning">
          <AlertTriangle size={16} />
          <span>{t.desktop.logging.diagnosticWarning}</span>
        </div>
      ) : null}
      <div className="desktop-logging-sinks">
        <LoggingSinkCard label="Desktop / Gateway" status={health.logging.desktop} />
        <LoggingSinkCard label="agent-cli" status={health.logging.agent_cli} />
      </div>
      <div className="desktop-log-directory">
        <div><span>{t.desktop.logging.directory}</span><code>{setup.logging.directory}</code></div>
        <button onClick={onOpenLogsDirectory} type="button"><ExternalLink size={14} />{t.desktop.logging.openDirectory}</button>
      </div>
    </section>
  );
}

function ConfigImportDialog({
  preview,
  applying,
  diagnosticConfirmed,
  onDiagnosticConfirmed,
  onCancel,
  onApply,
}: {
  preview: DesktopConfigImportPreview;
  applying: boolean;
  diagnosticConfirmed: boolean;
  onDiagnosticConfirmed: (confirmed: boolean) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const t = useUiText();
  const closeDialog = () => {
    if (!applying) onCancel();
  };
  const dialogRef = useDialogFocus<HTMLElement>(true, closeDialog);
  return (
    <div className="modal-backdrop desktop-config-import-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeDialog();
    }}>
      <section
        aria-labelledby="desktop-config-import-title"
        aria-modal="true"
        className="desktop-config-import-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="desktop-eyebrow">{t.desktop.configImport.eyebrow}</p>
            <h2 id="desktop-config-import-title">{t.desktop.configImport.title(preview.file_name)}</h2>
            <p>{t.desktop.configImport.hint}</p>
          </div>
          <button aria-label={t.desktop.configImport.cancelAria} disabled={applying} onClick={onCancel} type="button">
            <X size={18} />
          </button>
        </header>
        <div className="desktop-config-import-groups">
          {preview.groups.map((group) => (
            <article className={`desktop-config-import-group status-${group.status}`} key={group.group}>
              <div>
                <strong>{group.label}</strong>
                <span>{group.status === "ready" ? t.desktop.configImport.ready : t.desktop.configImport.pending}</span>
              </div>
              <p>{t.desktop.configImport.detected(group.detected_fields.join(t.desktop.listSeparator))}</p>
              {group.overwritten_fields.length > 0 ? (
                <p className="desktop-config-import-overwrite">{t.desktop.configImport.overwrite(group.overwritten_fields.join(t.desktop.listSeparator))}</p>
              ) : null}
              <IntegrationIssues issues={group.issues} />
            </article>
          ))}
        </div>
        {preview.unknown_variable_count > 0 ? (
          <p className="desktop-config-import-note">{t.desktop.configImport.unknownVariables(String(preview.unknown_variable_count))}</p>
        ) : null}
        {preview.warnings.length > 0 ? (
          <ul className="desktop-config-import-warnings">
            {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        ) : null}
        {preview.diagnostic_logging ? (
          <label className="desktop-config-import-diagnostic">
            <input
              checked={diagnosticConfirmed}
              onChange={(event) => onDiagnosticConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>{t.desktop.configImport.diagnosticConfirm}</span>
          </label>
        ) : null}
        <footer>
          <button disabled={applying} onClick={onCancel} type="button">{t.desktop.cancel}</button>
          <button
            className="desktop-primary-button"
            disabled={applying || (preview.diagnostic_logging && !diagnosticConfirmed)}
            onClick={onApply}
            type="button"
          >
            {applying ? t.desktop.configImport.applying : t.desktop.configImport.apply}
          </button>
        </footer>
      </section>
    </div>
  );
}

function DesktopConfirmationDialog({
  confirmation,
  onCancel,
  onConfirm,
}: {
  confirmation: DesktopConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useUiText();
  const dialogRef = useDialogFocus<HTMLElement>(true, onCancel);
  const diagnostic = confirmation.kind === "diagnostic";
  const title = diagnostic ? t.desktop.confirm.diagnosticTitle : t.desktop.confirm.clearTitle(confirmation.label);
  const description = diagnostic
    ? t.desktop.confirm.diagnosticDescription
    : t.desktop.confirm.clearDescription(confirmation.label);
  return (
    <div className="modal-backdrop desktop-confirm-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <section
        aria-labelledby="desktop-confirm-title"
        aria-modal="true"
        className="desktop-confirm-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={diagnostic ? "desktop-confirm-icon warning" : "desktop-confirm-icon danger"}>
          <AlertTriangle aria-hidden="true" size={18} />
        </div>
        <div>
          <h2 id="desktop-confirm-title">{title}</h2>
          <p>{description}</p>
        </div>
        <footer>
          <button onClick={onCancel} type="button">{t.desktop.cancel}</button>
          <button
            className={diagnostic ? "desktop-primary-button" : "desktop-primary-button desktop-danger-button"}
            onClick={onConfirm}
            type="button"
          >
            {diagnostic ? t.desktop.confirm.diagnosticConfirm : t.desktop.confirm.clearConfirm}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function DesktopShell({
  children,
  fontSize,
  language,
  onFontSizeChange,
  onLanguageChange,
}: {
  children: (context: {
    cloud: DesktopCloudState;
    health: DesktopHealth;
    openSettings: (section?: DesktopSettingsSection) => void;
  }) => ReactNode;
  fontSize: DashboardFontSize;
  language: Language;
  onFontSizeChange: (fontSize: DashboardFontSize) => void;
  onLanguageChange: (language: Language) => void;
}) {
  const queryClient = useQueryClient();
  const t = useUiText();
  const desktop = window.lxe?.desktop;
  const [setup, setSetup] = useState<DesktopSetupState | null>(null);
  const [health, setHealth] = useState<DesktopHealth | null>(null);
  const [cloud, setCloud] = useState<DesktopCloudState | null>(null);
  const [form, setForm] = useState<SetupForm | null>(null);
  const [activeSettingsSection, setActiveSettingsSection] = useState<DesktopSettingsSection>("cloud");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [cloudActivating, setCloudActivating] = useState(false);
  const [cloudEnrollment, setCloudEnrollment] = useState<DesktopCloudEnrollmentSelection | null>(null);
  const [cloudPassword, setCloudPassword] = useState("");
  const [importPreview, setImportPreview] = useState<DesktopConfigImportPreview | null>(null);
  const [importApplying, setImportApplying] = useState(false);
  const [importDiagnosticConfirmed, setImportDiagnosticConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState<DesktopConfirmation | null>(null);
  const [notice, setNotice] = useState<DesktopNoticeState | null>(null);
  const [error, setError] = useState("");
  const [appGeneration, setAppGeneration] = useState(0);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const noticeSequence = useRef(0);
  const showProgressNotice = (message: string): void => {
    noticeSequence.current += 1;
    setNotice(desktopProgressNotice(noticeSequence.current, message));
  };
  const showSuccessNotice = (message: string): void => {
    noticeSequence.current += 1;
    setNotice(desktopSuccessNotice(noticeSequence.current, message));
  };
  const closeSettings = (): void => {
    setConfirmation(null);
    setSettingsOpen(false);
  };
  const settingsDialogRef = useDialogFocus<HTMLFormElement>(settingsOpen, closeSettings);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void Promise.all([desktop.getSetupState(), desktop.getHealth(), desktop.getCloudState()]).then(([
      nextSetup,
      nextHealth,
      nextCloud,
    ]) => {
      if (cancelled) return;
      setSetup(nextSetup);
      setHealth(nextHealth);
      setCloud(nextCloud);
      setForm(setupForm(nextSetup));
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    const unsubscribeHealth = desktop.onStatusChanged((nextHealth) => {
      if (!cancelled) setHealth(nextHealth);
    });
    const unsubscribeCloud = desktop.onCloudStateChanged((nextCloud) => {
      if (!cancelled) setCloud(nextCloud);
    });
    return () => {
      cancelled = true;
      unsubscribeCloud();
      unsubscribeHealth();
    };
  }, [desktop]);

  useEffect(() => {
    if (!notice?.autoDismissMs) return;
    const noticeId = notice.id;
    const timer = window.setTimeout(() => {
      setNotice((current) => current?.id === noticeId ? null : current);
    }, notice.autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!desktop) {
    return <main className="desktop-loading" data-lxe-root-state="fatal">{t.desktop.preloadUnavailable}</main>;
  }
  const frameClassName = `desktop-window-frame desktop-platform-${desktop.platform}`;
  const dragRegion = <div aria-hidden className="desktop-window-drag-region" />;
  if (!setup || !form || !health || !cloud) {
    return (
      <main className={`desktop-loading ${frameClassName}`} data-lxe-root-state="loading">
        {dragRegion}
        {error || t.desktop.loading}
      </main>
    );
  }

  const updateForm = (patch: Partial<SetupForm>): void => setForm((current) => current ? { ...current, ...patch } : current);
  const refreshSetup = async (next: DesktopSetupState): Promise<void> => {
    queryClient.clear();
    setSetup(next);
    setForm(setupForm(next));
    setHealth(await desktop.getHealth());
    setAppGeneration((value) => value + 1);
  };
  const selectWorkspace = async (): Promise<void> => {
    const selected = await desktop.selectWorkspace();
    if (selected) updateForm({ workspaceRoot: selected });
  };
  const selectZiniaoApp = async (): Promise<void> => {
    const selected = await desktop.selectZiniaoApp();
    if (selected) updateForm({ ziniaoAppPath: selected });
  };
  const selectZiniaoWebDriverDirectory = async (): Promise<void> => {
    const selected = await desktop.selectZiniaoWebDriverDirectory();
    if (selected) updateForm({ ziniaoWebDriverPath: selected });
  };
  const selectConfigImport = async (): Promise<void> => {
    if (importApplying) return;
    setError("");
    setNotice(null);
    try {
      const preview = await desktop.selectConfigImport();
      if (!preview) return;
      setImportPreview(preview);
      setImportDiagnosticConfirmed(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const selectCloudEnrollment = async (): Promise<void> => {
    if (importApplying) return;
    setError("");
    try {
      const selection = await desktop.selectCloudEnrollment();
      if (selection) setCloudEnrollment(selection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const activateCloudEnrollment = async (): Promise<void> => {
    if (!cloudEnrollment || importApplying) return;
    setCloudActivating(true);
    setError("");
    try {
      const nextCloud = await desktop.activateCloudEnrollment({
        enrollment_id: cloudEnrollment.enrollment_id,
        password: cloudPassword,
      });
      setCloud(nextCloud);
      if (nextCloud.configured) {
        setCloudEnrollment(null);
        setCloudPassword("");
        showSuccessNotice(nextCloud.connection === "connected" ? t.desktop.cloud.activatedConnected : t.desktop.cloud.activatedRetry);
      }
    } catch (cause) {
      setCloud(await desktop.getCloudState());
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCloudActivating(false);
    }
  };
  const retryCloudConnection = async (): Promise<void> => {
    if (importApplying) return;
    setCloudActivating(true);
    setError("");
    try {
      setCloud(await desktop.retryCloudConnection());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCloudActivating(false);
    }
  };
  const openCloudDestination = async (destination: DesktopCloudDestination): Promise<void> => {
    if (importApplying || cloud.connection !== "connected") return;
    setError("");
    try {
      await desktop.openCloudDestination(destination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const cancelConfigImport = async (): Promise<void> => {
    const preview = importPreview;
    setImportPreview(null);
    setImportDiagnosticConfirmed(false);
    if (!preview) return;
    try {
      await desktop.discardConfigImport(preview.import_id);
    } catch {
      // Expired and replaced drafts are already unusable.
    }
  };
  const applyConfigImport = async (): Promise<void> => {
    const preview = importPreview;
    if (!preview) return;
    setImportApplying(true);
    setImportPreview(null);
    setImportDiagnosticConfirmed(false);
    setConfirmation(null);
    setError("");
    showProgressNotice(t.desktop.configImport.progress);
    try {
      const result = await desktop.applyConfigImport(preview.import_id);
      await refreshSetup(result.state);
      showSuccessNotice(configImportSuccessMessage(t.desktop, result, preview.unknown_variable_count));
    } catch (cause) {
      setNotice(null);
      try {
        await refreshSetup(await desktop.getSetupState());
      } catch {
        // Preserve the actual import or restart error below.
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImportApplying(false);
    }
  };
  const baseInput = (): DesktopSetupInput => ({
    provider: form.provider,
    ...(form.apiKey ? { api_key: form.apiKey } : {}),
    workspace_root: form.workspaceRoot,
    logging: { profile: form.logProfile, retention_days: form.logRetentionDays },
  });
  const formInput = (): DesktopSetupInput => {
    const ziniaoTouched = hasText(
      form.ziniaoCompany,
      form.ziniaoUsername,
      form.ziniaoPassword,
      form.ziniaoAppPath,
      form.ziniaoWebDriverPath,
    ) || setup.ziniao.configured;
    const mabangTouched = hasText(form.mabangAccount, form.mabangPassword) || setup.mabang.configured;
    const feishuTouched = hasText(form.feishuAppId, form.feishuAppSecret) || setup.feishu.configured;
    return {
      ...baseInput(),
      ...(ziniaoTouched ? {
        ziniao: {
          action: "save" as const,
          company: form.ziniaoCompany,
          username: form.ziniaoUsername,
          ...(form.ziniaoPassword ? { password: form.ziniaoPassword } : {}),
          app_version: desktop.platform === "darwin" ? "v6" : form.ziniaoVersion,
          app_path: form.ziniaoAppPath,
          webdriver_path: form.ziniaoWebDriverPath,
        },
      } : {}),
      ...(mabangTouched ? {
        mabang: {
          action: "save" as const,
          account: form.mabangAccount,
          ...(form.mabangPassword ? { password: form.mabangPassword } : {}),
        },
      } : {}),
      ...(feishuTouched ? {
        feishu: {
          action: "save" as const,
          app_id: form.feishuAppId,
          ...(form.feishuAppSecret ? { app_secret: form.feishuAppSecret } : {}),
        },
      } : {}),
    };
  };
  const persistSetup = async (): Promise<void> => {
    if (importApplying) return;
    setSaving(true);
    setError("");
    try {
      await refreshSetup(await desktop.saveSetup(formInput()));
      closeSettings();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (importApplying) return;
    if (activeSettingsSection === "appearance"
      || activeSettingsSection === "cloud"
      || activeSettingsSection === "status") return;
    if (form.logProfile === "diagnostic" && setup.logging.profile !== "diagnostic") {
      setConfirmation({ kind: "diagnostic" });
      return;
    }
    void persistSetup();
  };
  const performClearIntegration = async (name: IntegrationName): Promise<void> => {
    if (importApplying) return;
    setSaving(true);
    setError("");
    try {
      const input: DesktopSetupInput = {
        ...(setup.complete ? {
          provider: setup.provider as Provider,
          workspace_root: setup.workspace_root,
          logging: {
            profile: setup.logging.profile,
            retention_days: setup.logging.retention_days,
          },
        } : {
          ...baseInput(),
          logging: {
            profile: setup.logging.profile,
            retention_days: setup.logging.retention_days,
          },
        }),
        [name]: { action: "clear" },
      };
      await refreshSetup(await desktop.saveSetup(input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const clearIntegration = (name: IntegrationName): void => {
    if (importApplying) return;
    setConfirmation({ kind: "clear-integration", integration: name, label: t.desktop.integrationNames[name] });
  };
  const confirmPendingAction = (): void => {
    if (importApplying) return;
    const pending = confirmation;
    if (!pending) return;
    setConfirmation(null);
    if (pending.kind === "diagnostic") {
      void persistSetup();
    } else {
      void performClearIntegration(pending.integration);
    }
  };
  const restart = async (): Promise<void> => {
    if (importApplying) return;
    setRestarting(true);
    setError("");
    try {
      setHealth(await desktop.restartAgent());
      queryClient.clear();
      setAppGeneration((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestarting(false);
    }
  };
  const baseline = setupForm(setup);
  const editableSection: EditableDesktopSettingsSection = activeSettingsSection === "status"
    || activeSettingsSection === "appearance"
    || activeSettingsSection === "cloud"
    ? "base"
    : activeSettingsSection;
  const selectSettingsSection = (section: DesktopSettingsSection): void => {
    setActiveSettingsSection(section);
    window.requestAnimationFrame(() => sectionHeadingRef.current?.focus());
  };
  const settingsFields = (
    <DesktopSettingsForm
      activeSection={editableSection}
      form={form}
      health={health}
      headingRef={sectionHeadingRef}
      onChange={updateForm}
      onClearIntegration={clearIntegration}
      onOpenLogsDirectory={() => { void desktop.openLogsDirectory().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      }); }}
      onSelectWorkspace={() => { void selectWorkspace(); }}
      onSelectZiniaoApp={() => { void selectZiniaoApp(); }}
      onSelectZiniaoWebDriverDirectory={() => { void selectZiniaoWebDriverDirectory(); }}
      platform={desktop.platform}
      requireKey={!setup.provider_key_configured}
      setup={setup}
    />
  );
  const settingsBodyContent = activeSettingsSection === "cloud" ? (
    <DesktopCloudPanel
      activating={cloudActivating || importApplying}
      cloud={cloud}
      enrollment={cloudEnrollment}
      headingRef={sectionHeadingRef}
      onActivate={() => { void activateCloudEnrollment(); }}
      onOpenDestination={(destination) => { void openCloudDestination(destination); }}
      onPasswordChange={setCloudPassword}
      onRetry={() => { void retryCloudConnection(); }}
      onSelect={() => { void selectCloudEnrollment(); }}
      password={cloudPassword}
    />
  ) : activeSettingsSection === "appearance" ? (
    <DesktopAppearancePanel
      fontSize={fontSize}
      headingRef={sectionHeadingRef}
      onFontSizeChange={onFontSizeChange}
    />
  ) : settingsFields;
  const settingsBody = (
    <fieldset className="desktop-settings-fieldset" disabled={importApplying}>
      {settingsBodyContent}
    </fieldset>
  );
  const settingsNavigation = (showStatus: boolean) => (
    <DesktopSettingsNavigation
      activeSection={activeSettingsSection}
      baseline={baseline}
      form={form}
      fontSize={fontSize}
      health={health}
      cloud={cloud}
      configurationBusy={importApplying}
      language={language}
      onLanguageChange={onLanguageChange}
      onSelect={selectSettingsSection}
      onSelectConfigImport={() => { void selectConfigImport(); }}
      setup={setup}
      showStatus={showStatus}
    />
  );
  const importDialog = importPreview ? (
    <ConfigImportDialog
      applying={importApplying}
      diagnosticConfirmed={importDiagnosticConfirmed}
      onApply={() => { void applyConfigImport(); }}
      onCancel={() => { void cancelConfigImport(); }}
      onDiagnosticConfirmed={setImportDiagnosticConfirmed}
      preview={importPreview}
    />
  ) : null;
  const confirmationDialog = confirmation ? (
    <DesktopConfirmationDialog
      confirmation={confirmation}
      onCancel={() => setConfirmation(null)}
      onConfirm={confirmPendingAction}
    />
  ) : null;

  if (!setup.complete) {
    return (
      <main className={`desktop-onboarding ${frameClassName}`} data-lxe-root-state="setup">
        {dragRegion}
        <form className="desktop-onboarding-card desktop-settings-surface" onSubmit={save}>
          <div className="desktop-onboarding-header">
            <div className="desktop-onboarding-mark"><BrandMark title="LXE Agent" /></div>
            <div>
              <p className="desktop-eyebrow">{t.desktop.onboarding.eyebrow}</p>
              <h1>{t.desktop.onboarding.title}</h1>
              <p className="desktop-onboarding-copy">{t.desktop.onboarding.copy}</p>
            </div>
          </div>
          <div className="desktop-settings-workspace">
            {settingsNavigation(false)}
            <div className="desktop-settings-content">
              {settingsBody}
              {notice ? (
                <DesktopNoticeMessage
                  className="desktop-form-notice"
                  notice={notice}
                  onDismiss={() => setNotice(null)}
                />
              ) : null}
              {error ? <p className="desktop-form-error" role="alert">{error}</p> : null}
            </div>
          </div>
          <footer className="desktop-onboarding-footer">
            <span>{activeSettingsSection === "appearance"
              ? t.desktop.onboarding.footerAppearance
              : activeSettingsSection === "cloud"
                ? t.desktop.onboarding.footerCloud
                : t.desktop.onboarding.footerBase}</span>
            {activeSettingsSection !== "appearance" && activeSettingsSection !== "cloud" ? (
              <button className="desktop-primary-button" disabled={saving || importApplying} type="submit">
                {importApplying ? t.desktop.onboarding.applying : saving ? t.desktop.onboarding.starting : t.desktop.onboarding.submit}
              </button>
            ) : null}
          </footer>
        </form>
        {importDialog}
        {confirmationDialog}
      </main>
    );
  }

  const openSettings = (section: DesktopSettingsSection = "status"): void => {
    setForm(setupForm(setup));
    setActiveSettingsSection(section);
    setConfirmation(null);
    setError("");
    setSettingsOpen(true);
  };
  return (
    <div className={frameClassName} data-lxe-root-state="ready">
      {dragRegion}
      <div key={appGeneration}>{children({ cloud, health, openSettings })}</div>
      {notice && !settingsOpen ? (
        <DesktopNoticeMessage
          className="desktop-import-toast"
          notice={notice}
          onDismiss={() => setNotice(null)}
        />
      ) : null}
      {settingsOpen ? (
        <div className="modal-backdrop desktop-settings-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeSettings();
        }}>
          <form
            aria-labelledby="desktop-settings-title"
            aria-modal="true"
            className="desktop-settings-modal"
            onSubmit={save}
            ref={settingsDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <div>
                <p className="desktop-eyebrow">LXE Agent Desktop</p>
                <h2 id="desktop-settings-title">{t.desktop.settingsTitle}</h2>
              </div>
              <button aria-label={t.desktop.closeSettings} className="desktop-close-button" onClick={closeSettings} type="button">
                <X size={18} />
              </button>
            </header>
            <div className="desktop-settings-workspace">
              {settingsNavigation(true)}
              <div className="desktop-settings-content">
                {activeSettingsSection === "status" ? (
                  <DesktopStatusPanel
                    headingRef={sectionHeadingRef}
                    health={health}
                    onRestart={() => { void restart(); }}
                    restarting={restarting || importApplying}
                  />
                ) : settingsBody}
                {notice ? (
                  <DesktopNoticeMessage
                    className="desktop-form-notice"
                    notice={notice}
                    onDismiss={() => setNotice(null)}
                  />
                ) : null}
                {error ? <p className="desktop-form-error" role="alert">{error}</p> : null}
              </div>
            </div>
            <footer>
              <span className="desktop-version">{health?.version ? `v${health.version}` : "—"}</span>
              {activeSettingsSection !== "status"
                && activeSettingsSection !== "appearance"
                && activeSettingsSection !== "cloud" ? (
                <button className="desktop-primary-button" disabled={saving || importApplying} type="submit">
                  {importApplying ? t.desktop.settings.applying : saving ? t.desktop.settings.saving : t.desktop.settings.submit}
                </button>
              ) : null}
            </footer>
          </form>
        </div>
      ) : null}
      {importDialog}
      {confirmationDialog}
    </div>
  );
}
