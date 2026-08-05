import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Cloud,
  ExternalLink,
  Feather,
  FileKey2,
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
  DesktopCloudDestination,
  DesktopCloudEnrollmentSelection,
  DesktopCloudState,
  DesktopHealth,
  DesktopModelProvider,
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopSetupInput,
  DesktopSetupState,
  DesktopZiniaoVersion,
} from "@lxe/desktop-protocol";
import { BrandMark } from "../shared/ui/brand-mark";
import { useUiText } from "../shared/i18n";
import type { Language, UiText } from "../shared/i18n";
import type { DashboardFontSize, DashboardTheme } from "../shared/appearance";
import { LanguageSwitch } from "../shared/ui/language-switch";
import { useDialogFocus } from "../shared/ui/use-dialog-focus";
import {
  desktopSuccessNotice,
  type DesktopNoticeState,
} from "./notice-model";
import {
  initialOnboardingDismissed,
  storeOnboardingDismissed,
} from "./onboarding-preference";
import {
  desktopSettingsForm,
  desktopCloudBindingSwitchAvailable,
  desktopLoggingSinkView,
  desktopSettingsSectionIsDirty,
  desktopSettingsSectionStatus,
  type DesktopSettingsFormValue,
  type DesktopSettingsSection,
  type EditableDesktopSettingsSection,
} from "./settings-model";

type Provider = DesktopModelProvider;
type IntegrationName = "ziniao" | "mabang" | "feishu";
type SetupForm = DesktopSettingsFormValue;
type DesktopConfirmation =
  | { kind: "diagnostic" }
  | { kind: "clear-integration"; integration: IntegrationName; label: string }
  | { kind: "delete-local-model"; provider: Provider; label: string };
const setupForm = desktopSettingsForm;

const PROVIDER_LABELS: Record<Provider, string> = {
  kimi_coding: "Kimi Coding",
  deepseek: "DeepSeek",
  glm: "GLM",
};

const FONT_SIZE_VALUES: ReadonlyArray<DashboardFontSize> = ["small", "standard", "large"];
const THEME_VALUES: ReadonlyArray<DashboardTheme> = ["system", "light", "dark"];

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
  onSwitchBinding,
  enrollmentError,
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
  onSwitchBinding: () => void;
  enrollmentError: string;
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
  const deviceIdentity = [cloud.device_name.trim(), cloud.vpn_ip.trim()].filter(Boolean).join(" · ");
  return (
    <section className="desktop-settings-section desktop-cloud-panel">
      <DesktopSectionHeading
        badge={!cloud.configured
          ? supported
            ? t.desktop.cloud.unconfiguredBadge
            : t.desktop.cloud.unsupportedBadge
          : undefined}
        badgeClassName="desktop-cloud-badge"
        description={t.desktop.cloud.description}
        headingRef={headingRef}
        title={t.desktop.sectionTitles.cloud}
      />
      {cloud.configured ? (
        <div className={`desktop-cloud-overview ${cloud.connection}`}>
          <span className="desktop-cloud-overview-icon"><Cloud aria-hidden size={18} /></span>
          <div aria-live="polite" className="desktop-cloud-overview-copy">
            <strong>{connected ? t.desktop.cloud.connected : cloud.last_error || t.desktop.cloud.checking}</strong>
            {deviceIdentity ? <span>{deviceIdentity}</span> : null}
          </div>
          <div className="desktop-cloud-overview-actions">
            {!connected ? (
              <button disabled={activating} onClick={onRetry} type="button">
                <RotateCcw size={15} />
                {t.desktop.cloud.retry}
              </button>
            ) : null}
            {desktopCloudBindingSwitchAvailable(cloud) ? (
              <button disabled={activating} onClick={onSwitchBinding} type="button">
                <FileKey2 size={15} />
                {t.desktop.cloud.switchBinding}
              </button>
            ) : null}
          </div>
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
      {!cloud.configured && (enrollmentError || cloud.last_error) ? (
        <p className="desktop-form-error" role="alert">{enrollmentError || cloud.last_error}</p>
      ) : null}
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
  onThemeChange,
  theme,
}: {
  fontSize: DashboardFontSize;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onFontSizeChange: (fontSize: DashboardFontSize) => void;
  onThemeChange: (theme: DashboardTheme) => void;
  theme: DashboardTheme;
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
      <div aria-label={t.desktop.appearance.themeAria} className="desktop-appearance-options" role="group">
        {THEME_VALUES.map((value) => {
          const option = t.desktop.themeOptions[value];
          return (
            <button
              aria-pressed={theme === value}
              className={`desktop-appearance-option${theme === value ? " active" : ""}`}
              key={value}
              onClick={() => onThemeChange(value)}
              type="button"
            >
              <strong>{option.label}</strong>
              <span>{option.description}</span>
            </button>
          );
        })}
      </div>
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
  credentialBusy,
  form,
  health,
  headingRef,
  setup,
  platform,
  onChange,
  onDeleteLocalCredential,
  onSaveLocalCredential,
  onSelectWorkspace,
  onSelectZiniaoApp,
  onSelectZiniaoWebDriverDirectory,
  onOpenLogsDirectory,
  onClearIntegration,
}: {
  activeSection: EditableDesktopSettingsSection;
  credentialBusy: boolean;
  form: SetupForm;
  health: DesktopHealth;
  headingRef: RefObject<HTMLHeadingElement | null>;
  setup: DesktopSetupState;
  platform: "win32" | "darwin" | "linux";
  onChange: (patch: Partial<SetupForm>) => void;
  onDeleteLocalCredential: (provider: Provider) => void;
  onSaveLocalCredential: () => void;
  onSelectWorkspace: () => void;
  onSelectZiniaoApp: () => void;
  onSelectZiniaoWebDriverDirectory: () => void;
  onOpenLogsDirectory: () => void;
  onClearIntegration: (name: IntegrationName) => void;
}) {
  const t = useUiText();
  if (activeSection === "base") {
    const selectedProviderConfigured = setup.local_model_credentials[form.localProvider];
    return (
      <section className="desktop-settings-section">
        <DesktopSectionHeading
          badge={t.desktop.base.badge}
          badgeClassName="desktop-appearance-badge"
          description={t.desktop.base.description}
          headingRef={headingRef}
          title={t.desktop.sectionTitles.base}
        />
        <div className="desktop-local-model-card">
          <div className="desktop-local-model-heading">
            <div>
              <strong>{t.desktop.base.localCredentials}</strong>
              <span>{t.desktop.base.localCredentialsDescription}</span>
            </div>
            <span className={selectedProviderConfigured ? "configured" : "optional"}>
              {selectedProviderConfigured ? t.desktop.base.configured : t.desktop.base.notConfigured}
            </span>
          </div>
          <div className="desktop-field-grid">
            <label>
              <span>{t.desktop.base.provider}</span>
              <select
                disabled={credentialBusy}
                value={form.localProvider}
                onChange={(event) => onChange({ localProvider: event.target.value as Provider, localApiKey: "" })}
              >
                {Object.entries(PROVIDER_LABELS).map(([provider, label]) => (
                  <option key={provider} value={provider}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t.desktop.base.apiKey}</span>
              <input
                autoComplete="new-password"
                disabled={credentialBusy}
                onChange={(event) => onChange({ localApiKey: event.target.value })}
                placeholder={t.desktop.base.apiKeyPlaceholder}
                type="password"
                value={form.localApiKey}
              />
            </label>
          </div>
          <div className="desktop-local-model-actions">
            <button
              className="desktop-primary-button"
              disabled={credentialBusy || form.localApiKey.trim().length === 0}
              onClick={onSaveLocalCredential}
              type="button"
            >
              <FileKey2 size={15} />
              {credentialBusy ? t.desktop.base.savingLocalKey : t.desktop.base.saveLocalKey}
            </button>
            {selectedProviderConfigured ? (
              <button
                className="desktop-local-model-delete"
                disabled={credentialBusy}
                onClick={() => onDeleteLocalCredential(form.localProvider)}
                type="button"
              >
                <Trash2 size={15} />
                {t.desktop.base.deleteLocalKey}
              </button>
            ) : null}
          </div>
          <p className="desktop-form-hint desktop-local-model-warning"><AlertTriangle size={14} />{t.desktop.base.plaintextWarning}</p>
          <div className="desktop-local-auth-path">
            <span>{t.desktop.base.localAuthPath}</span>
            <code title={setup.local_auth_path}>{setup.local_auth_path}</code>
          </div>
          {setup.local_auth_error ? <p className="desktop-form-error" role="alert">{setup.local_auth_error}</p> : null}
        </div>
        <div className="desktop-field-grid">
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

function CloudBindingDialog({
  activating,
  cloud,
  enrollment,
  error,
  password,
  onActivate,
  onCancel,
  onPasswordChange,
  onSelect,
}: {
  activating: boolean;
  cloud: DesktopCloudState;
  enrollment: DesktopCloudEnrollmentSelection | null;
  error: string;
  password: string;
  onActivate: () => void;
  onCancel: () => void;
  onPasswordChange: (value: string) => void;
  onSelect: () => void;
}) {
  const t = useUiText();
  const closeDialog = () => {
    if (!activating) onCancel();
  };
  const dialogRef = useDialogFocus<HTMLElement>(true, closeDialog);
  const currentDevice = [cloud.device_name.trim(), cloud.vpn_ip.trim()].filter(Boolean).join(" · ");
  return (
    <div className="modal-backdrop desktop-cloud-binding-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeDialog();
    }}>
      <section
        aria-labelledby="desktop-cloud-binding-title"
        aria-modal="true"
        className="desktop-cloud-binding-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="desktop-eyebrow">{t.desktop.cloud.bindingDialog.eyebrow}</p>
            <h2 id="desktop-cloud-binding-title">{t.desktop.cloud.bindingDialog.title}</h2>
            <p>{t.desktop.cloud.bindingDialog.description}</p>
          </div>
          <button
            aria-label={t.desktop.cloud.bindingDialog.cancelAria}
            disabled={activating}
            onClick={onCancel}
            type="button"
          >
            <X size={18} />
          </button>
        </header>
        <div className="desktop-cloud-binding-current">
          <span>{t.desktop.cloud.bindingDialog.currentDevice}</span>
          <strong>{currentDevice || cloud.device_id}</strong>
        </div>
        <p className="desktop-cloud-binding-warning">{t.desktop.cloud.bindingDialog.warning}</p>
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
        </div>
        {error ? <p className="desktop-form-error" role="alert">{error}</p> : null}
        <footer>
          <button disabled={activating} onClick={onCancel} type="button">{t.desktop.cancel}</button>
          <button
            className="desktop-primary-button"
            disabled={activating || !enrollment || password.trim().length < 12}
            onClick={onActivate}
            type="button"
          >
            <Cloud size={16} />
            {activating ? t.desktop.cloud.bindingDialog.switching : t.desktop.cloud.bindingDialog.confirm}
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
  const deletingKey = confirmation.kind === "delete-local-model";
  const title = diagnostic
    ? t.desktop.confirm.diagnosticTitle
    : deletingKey
      ? t.desktop.confirm.deleteKeyTitle(confirmation.label)
      : t.desktop.confirm.clearTitle(confirmation.label);
  const description = diagnostic
    ? t.desktop.confirm.diagnosticDescription
    : deletingKey
      ? t.desktop.confirm.deleteKeyDescription
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
            {diagnostic
              ? t.desktop.confirm.diagnosticConfirm
              : deletingKey
                ? t.desktop.confirm.deleteKeyConfirm
                : t.desktop.confirm.clearConfirm}
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
  onThemeChange,
  theme,
}: {
  children: (context: {
    cloud: DesktopCloudState;
    health: DesktopHealth;
    openSettings: (section?: DesktopSettingsSection) => void;
    setupComplete: boolean;
  }) => ReactNode;
  fontSize: DashboardFontSize;
  language: Language;
  onFontSizeChange: (fontSize: DashboardFontSize) => void;
  onLanguageChange: (language: Language) => void;
  onThemeChange: (theme: DashboardTheme) => void;
  theme: DashboardTheme;
}) {
  const queryClient = useQueryClient();
  const t = useUiText();
  const desktop = window.lxe?.desktop;
  const [setup, setSetup] = useState<DesktopSetupState | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    () => initialOnboardingDismissed(),
  );
  const [health, setHealth] = useState<DesktopHealth | null>(null);
  const [cloud, setCloud] = useState<DesktopCloudState | null>(null);
  const [form, setForm] = useState<SetupForm | null>(null);
  const [activeSettingsSection, setActiveSettingsSection] = useState<DesktopSettingsSection>("cloud");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [cloudActivating, setCloudActivating] = useState(false);
  const [cloudEnrollment, setCloudEnrollment] = useState<DesktopCloudEnrollmentSelection | null>(null);
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudBindingDialogOpen, setCloudBindingDialogOpen] = useState(false);
  const [cloudEnrollmentError, setCloudEnrollmentError] = useState("");
  const [confirmation, setConfirmation] = useState<DesktopConfirmation | null>(null);
  const [notice, setNotice] = useState<DesktopNoticeState | null>(null);
  const [error, setError] = useState("");
  const [appGeneration, setAppGeneration] = useState(0);
  const sectionHeadingRef = useRef<HTMLHeadingElement>(null);
  const noticeSequence = useRef(0);
  const setupComplete = useRef<boolean | null>(null);
  const showSuccessNotice = (message: string): void => {
    noticeSequence.current += 1;
    setNotice(desktopSuccessNotice(noticeSequence.current, message));
  };
  const closeSettings = (): void => {
    setConfirmation(null);
    setCloudBindingDialogOpen(false);
    setCloudEnrollment(null);
    setCloudPassword("");
    setCloudEnrollmentError("");
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
      setupComplete.current = nextSetup.complete;
      setHealth(nextHealth);
      setCloud(nextCloud);
      setForm(setupForm(nextSetup));
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    const unsubscribeHealth = desktop.onStatusChanged((nextHealth) => {
      if (cancelled) return;
      setHealth(nextHealth);
      void desktop.getSetupState().then((nextSetup) => {
        if (cancelled) return;
        const completeChanged = setupComplete.current !== nextSetup.complete;
        setupComplete.current = nextSetup.complete;
        setSetup(nextSetup);
        if (completeChanged) setForm(setupForm(nextSetup));
      }).catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
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

  useEffect(() => {
    if (!setup?.complete) return;
    storeOnboardingDismissed();
    setOnboardingDismissed(true);
  }, [setup?.complete]);

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
    setupComplete.current = next.complete;
    setSetup(next);
    setForm(setupForm(next));
    setHealth(await desktop.getHealth());
    setAppGeneration((value) => value + 1);
  };
  const refreshCredentialSetup = async (next: DesktopSetupState): Promise<void> => {
    queryClient.clear();
    setupComplete.current = next.complete;
    setSetup(next);
    setForm((current) => current ? { ...current, localApiKey: "" } : setupForm(next));
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
  const selectCloudEnrollment = async (): Promise<void> => {
    setCloudEnrollmentError("");
    try {
      const selection = await desktop.selectCloudEnrollment();
      if (selection) setCloudEnrollment(selection);
    } catch (cause) {
      setCloudEnrollmentError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const activateCloudEnrollment = async (): Promise<void> => {
    if (!cloudEnrollment) return;
    const switchingBinding = cloudBindingDialogOpen;
    setCloudActivating(true);
    setCloudEnrollmentError("");
    try {
      const nextCloud = await desktop.activateCloudEnrollment({
        enrollment_id: cloudEnrollment.enrollment_id,
        password: cloudPassword,
      });
      setCloud(nextCloud);
      if (nextCloud.configured) {
        setCloudEnrollment(null);
        setCloudPassword("");
        setCloudBindingDialogOpen(false);
        showSuccessNotice(switchingBinding
          ? nextCloud.connection === "connected"
            ? t.desktop.cloud.bindingDialog.switchedConnected(nextCloud.device_name)
            : t.desktop.cloud.bindingDialog.switchedRetry(nextCloud.device_name)
          : nextCloud.connection === "connected"
            ? t.desktop.cloud.activatedConnected
            : t.desktop.cloud.activatedRetry);
      }
    } catch (cause) {
      setCloud(await desktop.getCloudState());
      setCloudEnrollmentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCloudActivating(false);
    }
  };
  const openCloudBindingDialog = (): void => {
    setError("");
    setCloudEnrollment(null);
    setCloudPassword("");
    setCloudEnrollmentError("");
    setCloudBindingDialogOpen(true);
  };
  const closeCloudBindingDialog = (): void => {
    if (cloudActivating) return;
    setCloudBindingDialogOpen(false);
    setCloudEnrollment(null);
    setCloudPassword("");
    setCloudEnrollmentError("");
  };
  const retryCloudConnection = async (): Promise<void> => {
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
    if (cloud.connection !== "connected") return;
    setError("");
    try {
      await desktop.openCloudDestination(destination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const baseInput = (): DesktopSetupInput => ({
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
  const saveLocalCredential = async (): Promise<void> => {
    const apiKey = form.localApiKey.trim();
    if (!apiKey || credentialBusy) return;
    const provider = form.localProvider;
    setCredentialBusy(true);
    setError("");
    try {
      await refreshCredentialSetup(await desktop.saveLocalModelCredential({ provider, api_key: apiKey }));
      showSuccessNotice(t.desktop.base.savedLocalKey(PROVIDER_LABELS[provider]));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCredentialBusy(false);
    }
  };
  const performDeleteLocalCredential = async (provider: Provider): Promise<void> => {
    if (credentialBusy) return;
    setCredentialBusy(true);
    setError("");
    try {
      await refreshCredentialSetup(await desktop.deleteLocalModelCredential(provider));
      showSuccessNotice(t.desktop.base.deletedLocalKey(PROVIDER_LABELS[provider]));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCredentialBusy(false);
    }
  };
  const persistSetup = async (): Promise<void> => {
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
    setSaving(true);
    setError("");
    try {
      const input: DesktopSetupInput = {
        ...(setup.complete ? {
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
    setConfirmation({ kind: "clear-integration", integration: name, label: t.desktop.integrationNames[name] });
  };
  const deleteLocalCredential = (provider: Provider): void => {
    if (credentialBusy) return;
    setConfirmation({ kind: "delete-local-model", provider, label: PROVIDER_LABELS[provider] });
  };
  const confirmPendingAction = (): void => {
    const pending = confirmation;
    if (!pending) return;
    setConfirmation(null);
    if (pending.kind === "diagnostic") {
      void persistSetup();
    } else if (pending.kind === "clear-integration") {
      void performClearIntegration(pending.integration);
    } else {
      void performDeleteLocalCredential(pending.provider);
    }
  };
  const restart = async (): Promise<void> => {
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
      credentialBusy={credentialBusy}
      form={form}
      health={health}
      headingRef={sectionHeadingRef}
      onChange={updateForm}
      onClearIntegration={clearIntegration}
      onDeleteLocalCredential={deleteLocalCredential}
      onOpenLogsDirectory={() => { void desktop.openLogsDirectory().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      }); }}
      onSelectWorkspace={() => { void selectWorkspace(); }}
      onSelectZiniaoApp={() => { void selectZiniaoApp(); }}
      onSelectZiniaoWebDriverDirectory={() => { void selectZiniaoWebDriverDirectory(); }}
      onSaveLocalCredential={() => { void saveLocalCredential(); }}
      platform={desktop.platform}
      setup={setup}
    />
  );
  const settingsBodyContent = activeSettingsSection === "cloud" ? (
    <DesktopCloudPanel
      activating={cloudActivating}
      cloud={cloud}
      enrollment={cloudEnrollment}
      headingRef={sectionHeadingRef}
      onActivate={() => { void activateCloudEnrollment(); }}
      onOpenDestination={(destination) => { void openCloudDestination(destination); }}
      onPasswordChange={setCloudPassword}
      onRetry={() => { void retryCloudConnection(); }}
      onSelect={() => { void selectCloudEnrollment(); }}
      onSwitchBinding={openCloudBindingDialog}
      password={cloudPassword}
      enrollmentError={cloudEnrollmentError}
    />
  ) : activeSettingsSection === "appearance" ? (
    <DesktopAppearancePanel
      fontSize={fontSize}
      headingRef={sectionHeadingRef}
      onFontSizeChange={onFontSizeChange}
      onThemeChange={onThemeChange}
      theme={theme}
    />
  ) : settingsFields;
  const settingsBody = (
    <fieldset className="desktop-settings-fieldset" disabled={saving}>
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
      language={language}
      onLanguageChange={onLanguageChange}
      onSelect={selectSettingsSection}
      setup={setup}
      showStatus={showStatus}
    />
  );
  const confirmationDialog = confirmation ? (
    <DesktopConfirmationDialog
      confirmation={confirmation}
      onCancel={() => setConfirmation(null)}
      onConfirm={confirmPendingAction}
    />
  ) : null;
  const cloudBindingDialog = cloudBindingDialogOpen ? (
    <CloudBindingDialog
      activating={cloudActivating}
      cloud={cloud}
      enrollment={cloudEnrollment}
      error={cloudEnrollmentError}
      onActivate={() => { void activateCloudEnrollment(); }}
      onCancel={closeCloudBindingDialog}
      onPasswordChange={setCloudPassword}
      onSelect={() => { void selectCloudEnrollment(); }}
      password={cloudPassword}
    />
  ) : null;

  if (!setup.complete && !onboardingDismissed) {
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
            <button
              className="desktop-onboarding-skip"
              disabled={saving || credentialBusy}
              onClick={() => {
                storeOnboardingDismissed();
                setOnboardingDismissed(true);
              }}
              type="button"
            >
              {t.desktop.onboarding.defer}
            </button>
            {activeSettingsSection !== "appearance" && activeSettingsSection !== "cloud" ? (
              <button className="desktop-primary-button" disabled={saving || credentialBusy} type="submit">
                {saving ? t.desktop.onboarding.starting : t.desktop.onboarding.submit}
              </button>
            ) : null}
          </footer>
        </form>
        {confirmationDialog}
        {cloudBindingDialog}
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
      <div key={appGeneration}>{children({ cloud, health, openSettings, setupComplete: setup.complete })}</div>
      {notice && !settingsOpen ? (
        <DesktopNoticeMessage
          className="desktop-notice-toast"
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
                    restarting={restarting}
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
                <button className="desktop-primary-button" disabled={saving || credentialBusy} type="submit">
                  {saving ? t.desktop.settings.saving : t.desktop.settings.submit}
                </button>
              ) : null}
            </footer>
          </form>
        </div>
      ) : null}
      {confirmationDialog}
      {cloudBindingDialog}
    </div>
  );
}
