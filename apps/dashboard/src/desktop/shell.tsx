import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Cloud,
  ExternalLink,
  FileKey2,
  FileUp,
  FolderOpen,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type {
  DesktopConfigImportPreview,
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
import type { Language } from "../shared/i18n";
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

const stateLabel = (state: DesktopHealth["gateway"]): string => ({
  stopped: "已停止",
  starting: "启动中",
  ready: "运行中",
  error: "异常",
})[state];

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
  const view = desktopLoggingSinkView(status);
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
  language: Language;
  setup: DesktopSetupState;
  cloud: DesktopCloudState;
  showStatus: boolean;
  onLanguageChange: (language: Language) => void;
  onSelect: (section: DesktopSettingsSection) => void;
  onSelectConfigImport: () => void;
  configurationBusy: boolean;
}) {
  const item = (section: DesktopSettingsSection, label: string, status: string) => {
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
        <span>
          <strong>{label}</strong>
          <small>{status}</small>
        </span>
        {dirty ? (
          <i aria-label="有未保存修改" className="desktop-settings-dirty-dot" title="有未保存修改" />
        ) : null}
      </button>
    );
  };

  return (
    <nav aria-label="设置菜单" className="desktop-settings-nav">
      <div className="desktop-settings-nav-list">
        {showStatus ? item("status", "运行状态", stateLabel(health?.gateway ?? "starting")) : null}
        {item("cloud", "公司云端", ({
          connected: "已连接",
          connecting: "连接中",
          provisioning: "配置中",
          offline: "离线",
          error: "需处理",
          unsupported: "仅 Windows",
          not_configured: "未配置",
        } as const)[cloud.connection])}
        {item("base", "基础设置", desktopSettingsSectionStatus("base", setup))}
        <p className="desktop-settings-nav-group">业务集成</p>
        {item("ziniao", "紫鸟自动化", desktopSettingsSectionStatus("ziniao", setup))}
        {item("mabang", "马帮", desktopSettingsSectionStatus("mabang", setup))}
        {item("feishu", "飞书", desktopSettingsSectionStatus("feishu", setup))}
        {item("logging", "日志与排障", desktopSettingsSectionStatus("logging", setup))}
      </div>
      <div className="desktop-settings-nav-footer">
        <div className="desktop-settings-language">
          <span>界面语言</span>
          <LanguageSwitch language={language} onLanguageChange={onLanguageChange} />
        </div>
        <button
          className="desktop-settings-import-button"
          disabled={configurationBusy}
          onClick={onSelectConfigImport}
          type="button"
        >
          <FileUp size={15} />
          <span><strong>从 .env 导入</strong><small>读取本地配置文件</small></span>
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
  return (
    <div aria-live="polite" className={`${className} desktop-notice-message`} role="status">
      <span>{notice.message}</span>
      {notice.dismissible ? (
        <button aria-label="关闭提示" onClick={onDismiss} title="关闭提示" type="button">
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
  onPasswordChange: (value: string) => void;
  onRetry: () => void;
  onSelect: () => void;
}) {
  const connected = cloud.connection === "connected";
  const supported = cloud.connection !== "unsupported";
  return (
    <section className="desktop-settings-section desktop-cloud-panel">
      <DesktopSectionHeading
        badge={connected ? "已连接" : cloud.configured ? "已配置" : supported ? "未配置" : "仅 Windows"}
        badgeClassName={connected ? "desktop-cloud-badge connected" : "desktop-cloud-badge"}
        description="连接公司内网并启用每小时云端同步。"
        headingRef={headingRef}
        title="公司云端"
      />
      {cloud.configured ? (
        <div className="desktop-cloud-identity">
          <ShieldCheck aria-hidden size={20} />
          <div><strong>{cloud.device_name}</strong><span>{cloud.vpn_ip}</span></div>
        </div>
      ) : null}
      {!supported ? (
        <p className="desktop-form-hint">请在 Windows 10/11 x64 安装包中导入管理员提供的设备文件。</p>
      ) : !cloud.configured ? (
        <div className="desktop-cloud-activation">
          <button className="desktop-path-button" disabled={activating} onClick={onSelect} type="button">
            <FileKey2 size={17} />
            {enrollment?.file_name || "选择 .lxe-enroll 设备文件"}
          </button>
          <label>
            <span>一次性密码</span>
            <input
              autoComplete="off"
              disabled={activating}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder="输入管理员单独发送的密码"
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
            {activating ? "正在配置…" : "激活"}
          </button>
        </div>
      ) : null}
      {cloud.configured ? (
        <div className={`desktop-cloud-status ${cloud.connection}`}>
          <span>{connected ? "公司云端连接正常" : cloud.last_error || "正在检查公司网络"}</span>
          {!connected ? (
            <button disabled={activating} onClick={onRetry} type="button">
              <RotateCcw size={15} />
              重试连接
            </button>
          ) : null}
        </div>
      ) : cloud.last_error ? <p className="desktop-form-error" role="alert">{cloud.last_error}</p> : null}
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
  const hasHealthError = health
    ? [health.gateway, health.agent_cli, health.lxeskill].includes("error")
    : false;
  return (
    <section className="desktop-settings-section desktop-status-panel">
      <DesktopSectionHeading
        description="查看桌面核心组件、运行目录和当前后台状态。"
        headingRef={headingRef}
        title="运行状态"
      />
      <div className="desktop-health-grid">
        {([
          ["Gateway", health?.gateway],
          ["agent-cli", health?.agent_cli],
          ["lxeskill", health?.lxeskill],
        ] as const).map(([label, value]) => (
          <div className={`desktop-health-card state-${value ?? "stopped"}`} key={label}>
            <span>{label}</span>
            <strong>{stateLabel(value ?? "stopped")}</strong>
          </div>
        ))}
      </div>
      {health?.message && hasHealthError ? <p className="desktop-health-message">{health.message}</p> : null}
      <div className="desktop-maintenance-panel">
        <div className="desktop-maintenance-heading">
          <div>
            <strong>运行维护</strong>
            <span>查看目录或重新启动桌面后台。</span>
          </div>
          <button className="desktop-restart-button" disabled={restarting} onClick={onRestart} type="button">
            <RotateCcw size={15} />
            {restarting ? "重启中…" : "重启后台"}
          </button>
        </div>
        {health ? (
          <details className="desktop-diagnostics">
            <summary>运行目录</summary>
            <dl>
              <div><dt>资源目录</dt><dd>{health.resource_root}</dd></div>
              <div><dt>数据目录</dt><dd>{health.data_root}</dd></div>
              <div><dt>新会话默认工作区</dt><dd>{health.workspace_root}</dd></div>
            </dl>
          </details>
        ) : null}
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
  if (activeSection === "base") {
    return (
      <section className="desktop-settings-section">
        <DesktopSectionHeading
          badge="必填"
          badgeClassName="desktop-required-badge"
          description="启动 LXE Agent 所需的模型与本地工作区。"
          headingRef={headingRef}
          title="基础设置"
        />
        <div className="desktop-field-grid">
          <label>
            <span>模型服务</span>
            <select value={form.provider} onChange={(event) => onChange({ provider: event.target.value as Provider, apiKey: "" })}>
              <option value="kimi_coding">Kimi Coding</option>
              <option value="deepseek">DeepSeek</option>
              <option value="glm">GLM</option>
            </select>
          </label>
          <label>
            <span>API Key{requireKey ? "（必填）" : "（留空则保持不变）"}</span>
            <input
              autoComplete="new-password"
              onChange={(event) => onChange({ apiKey: event.target.value })}
              placeholder={requireKey ? "输入模型 API Key" : "已通过系统安全存储保存"}
              type="password"
              value={form.apiKey}
            />
          </label>
          <label className="desktop-field-wide">
            <span>新会话默认工作区</span>
            <span className="desktop-path-input">
              <input onChange={(event) => onChange({ workspaceRoot: event.target.value })} value={form.workspaceRoot} />
              <button onClick={onSelectWorkspace} title="选择文件夹" type="button"><FolderOpen size={17} /></button>
            </span>
          </label>
        </div>
      </section>
    );
  }

  if (activeSection === "ziniao") {
    const status = desktopSettingsSectionStatus("ziniao", setup);
    return (
      <section className="desktop-settings-section">
        <DesktopSectionHeading
          badge={status}
          badgeClassName={integrationStatusClass(setup.ziniao.managed, setup.ziniao.configured)}
          description="整组留空即可跳过；开始填写后，所有字段都需要完整。"
          headingRef={headingRef}
          title="紫鸟自动化"
        />
        <div className="desktop-integration-fields">
          <IntegrationIssues issues={setup.ziniao.issues} />
          <div className="desktop-field-grid">
            <label>
              <span>公司名</span>
              <input
                onChange={(event) => onChange({ ziniaoCompany: event.target.value })}
                placeholder="公司名"
                value={form.ziniaoCompany}
              />
            </label>
            <label>
              <span>账号</span>
              <input
                autoComplete="username"
                onChange={(event) => onChange({ ziniaoUsername: event.target.value })}
                placeholder="紫鸟账号"
                value={form.ziniaoUsername}
              />
            </label>
            <label>
              <span>密码{setup.ziniao.password_configured ? "（留空则保持不变）" : ""}</span>
              <input
                autoComplete="new-password"
                onChange={(event) => onChange({ ziniaoPassword: event.target.value })}
                placeholder={setup.ziniao.password_configured ? "已安全保存" : "紫鸟密码"}
                type="password"
                value={form.ziniaoPassword}
              />
            </label>
            <label>
              <span>APP 版本</span>
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
              <span>紫鸟 APP 文件地址</span>
              <span className="desktop-path-input">
                <input
                  onChange={(event) => onChange({ ziniaoAppPath: event.target.value })}
                  placeholder={platform === "darwin" ? "/Applications/紫鸟浏览器.app" : "C:\\Program Files\\ZiNiao\\ZiNiao.exe"}
                  value={form.ziniaoAppPath}
                />
                <button onClick={onSelectZiniaoApp} title="选择紫鸟 APP" type="button">
                  <FolderOpen size={17} />
                </button>
              </span>
            </label>
            <label className="desktop-field-wide">
              <span>浏览器驱动安装目录</span>
              <span className="desktop-path-input">
                <input
                  onChange={(event) => onChange({ ziniaoWebDriverPath: event.target.value })}
                  placeholder="驱动可以在首次运行时自动下载"
                  value={form.ziniaoWebDriverPath}
                />
                <button onClick={onSelectZiniaoWebDriverDirectory} title="选择驱动目录" type="button">
                  <FolderOpen size={17} />
                </button>
              </span>
            </label>
          </div>
          {setup.ziniao.managed ? (
            <button className="desktop-clear-integration" onClick={() => onClearIntegration("ziniao")} type="button">
              <Trash2 size={14} />清除配置并停用
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (activeSection === "mabang") {
    const status = desktopSettingsSectionStatus("mabang", setup);
    return (
      <section className="desktop-settings-section">
        <DesktopSectionHeading
          badge={status}
          badgeClassName={integrationStatusClass(setup.mabang.managed, setup.mabang.configured)}
          description="账号与密码必须成对填写；整组留空即可跳过。"
          headingRef={headingRef}
          title="马帮"
        />
        <div className="desktop-integration-fields">
          <IntegrationIssues issues={setup.mabang.issues} />
          <div className="desktop-field-grid">
            <label>
              <span>马帮账号</span>
              <input
                autoComplete="username"
                onChange={(event) => onChange({ mabangAccount: event.target.value })}
                value={form.mabangAccount}
              />
            </label>
            <label>
              <span>马帮密码{setup.mabang.password_configured ? "（留空则保持不变）" : ""}</span>
              <input
                autoComplete="new-password"
                onChange={(event) => onChange({ mabangPassword: event.target.value })}
                placeholder={setup.mabang.password_configured ? "已安全保存" : "输入马帮密码"}
                type="password"
                value={form.mabangPassword}
              />
            </label>
          </div>
          {setup.mabang.managed ? (
            <button className="desktop-clear-integration" onClick={() => onClearIntegration("mabang")} type="button">
              <Trash2 size={14} />清除配置并停用
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (activeSection === "feishu") {
    const status = desktopSettingsSectionStatus("feishu", setup);
    return (
      <section className="desktop-settings-section">
        <DesktopSectionHeading
          badge={status}
          badgeClassName={integrationStatusClass(setup.feishu.managed, setup.feishu.configured)}
          description="App ID 与 App Secret 必须成对填写；整组留空即可跳过。"
          headingRef={headingRef}
          title="飞书"
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
              <span>App Secret{setup.feishu.app_secret_configured ? "（留空则保持不变）" : ""}</span>
              <input
                autoComplete="new-password"
                onChange={(event) => onChange({ feishuAppSecret: event.target.value })}
                placeholder={setup.feishu.app_secret_configured ? "已安全保存" : "输入 App Secret"}
                type="password"
                value={form.feishuAppSecret}
              />
            </label>
          </div>
          {setup.feishu.managed ? (
            <button className="desktop-clear-integration" onClick={() => onClearIntegration("feishu")} type="button">
              <Trash2 size={14} />清除配置并停用
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="desktop-settings-section">
      <DesktopSectionHeading
        description="标准日志适合长期运行，排障日志仅建议在复现问题时开启。"
        headingRef={headingRef}
        title="日志与排障"
      />
      <div className="desktop-field-grid">
        <label>
          <span>日志档位</span>
          <select onChange={(event) => onChange({ logProfile: event.target.value as DesktopLogProfile })} value={form.logProfile}>
            <option value="off">关闭</option><option value="standard">标准</option><option value="diagnostic">排障</option>
          </select>
        </label>
        <label>
          <span>保留周期</span>
          <select
            disabled={form.logProfile === "off"}
            onChange={(event) => onChange({ logRetentionDays: Number(event.target.value) as DesktopLogRetentionDays })}
            value={form.logRetentionDays}
          >
            {[3, 7, 14, 30].map((days) => <option key={days} value={days}>{days} 天</option>)}
          </select>
        </label>
      </div>
      {form.logProfile === "diagnostic" ? (
        <div className="desktop-diagnostic-warning">
          <AlertTriangle size={16} />
          <span>排障日志会记录模型通信、紫鸟诊断和飞书原始事件，可能包含消息正文与账号标识。</span>
        </div>
      ) : null}
      <div className="desktop-logging-sinks">
        <LoggingSinkCard label="Desktop / Gateway" status={health.logging.desktop} />
        <LoggingSinkCard label="agent-cli" status={health.logging.agent_cli} />
      </div>
      <div className="desktop-log-directory">
        <div><span>日志目录</span><code>{setup.logging.directory}</code></div>
        <button onClick={onOpenLogsDirectory} type="button"><ExternalLink size={14} />打开目录</button>
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
            <p className="desktop-eyebrow">配置导入预览</p>
            <h2 id="desktop-config-import-title">确认导入 {preview.file_name}</h2>
            <p>这里只显示检测结果，API Key、密码和 App Secret 不会返回界面。</p>
          </div>
          <button aria-label="取消导入" disabled={applying} onClick={onCancel} type="button">
            <X size={18} />
          </button>
        </header>
        <div className="desktop-config-import-groups">
          {preview.groups.map((group) => (
            <article className={`desktop-config-import-group status-${group.status}`} key={group.group}>
              <div>
                <strong>{group.label}</strong>
                <span>{group.status === "ready" ? "可应用" : "待补全"}</span>
              </div>
              <p>检测到：{group.detected_fields.join("、")}</p>
              {group.overwritten_fields.length > 0 ? (
                <p className="desktop-config-import-overwrite">将覆盖：{group.overwritten_fields.join("、")}</p>
              ) : null}
              <IntegrationIssues issues={group.issues} />
            </article>
          ))}
        </div>
        {preview.unknown_variable_count > 0 ? (
          <p className="desktop-config-import-note">另有 {preview.unknown_variable_count} 个无关变量会被忽略。</p>
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
            <span>我了解排障日志可能包含飞书消息正文、账号标识和页面上下文。</span>
          </label>
        ) : null}
        <footer>
          <button disabled={applying} onClick={onCancel} type="button">取消</button>
          <button
            className="desktop-primary-button"
            disabled={applying || (preview.diagnostic_logging && !diagnosticConfirmed)}
            onClick={onApply}
            type="button"
          >
            {applying ? "正在导入…" : "确认导入并应用"}
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
  const dialogRef = useDialogFocus<HTMLElement>(true, onCancel);
  const diagnostic = confirmation.kind === "diagnostic";
  const title = diagnostic ? "开启排障日志？" : `清除${confirmation.label}配置？`;
  const description = diagnostic
    ? "排障日志可能包含飞书消息正文、账号标识和页面上下文。仅建议在复现问题时开启，完成后请恢复为标准或关闭。"
    : `保存的${confirmation.label}密码也会被删除，相关集成将立即停用。`;
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
          <button onClick={onCancel} type="button">取消</button>
          <button
            className={diagnostic ? "desktop-primary-button" : "desktop-primary-button desktop-danger-button"}
            onClick={onConfirm}
            type="button"
          >
            {diagnostic ? "确认开启并保存" : "清除并停用"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function DesktopShell({
  children,
  language,
  onLanguageChange,
}: {
  children: (context: {
    health: DesktopHealth;
    openSettings: (section?: DesktopSettingsSection) => void;
  }) => ReactNode;
  language: Language;
  onLanguageChange: (language: Language) => void;
}) {
  const queryClient = useQueryClient();
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
    const unsubscribe = desktop.onStatusChanged((nextHealth) => {
      if (!cancelled) setHealth(nextHealth);
    });
    return () => {
      cancelled = true;
      unsubscribe();
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
    return <main className="desktop-loading" data-lxe-root-state="fatal">桌面 preload bridge 不可用，LXE Agent 无法在普通浏览器中运行。</main>;
  }
  const frameClassName = `desktop-window-frame desktop-platform-${desktop.platform}`;
  const dragRegion = <div aria-hidden className="desktop-window-drag-region" />;
  if (!setup || !form || !health || !cloud) {
    return (
      <main className={`desktop-loading ${frameClassName}`} data-lxe-root-state="loading">
        {dragRegion}
        {error || "正在加载 LXE Agent…"}
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
        showSuccessNotice(nextCloud.connection === "connected" ? "公司云端已连接" : "公司云端已配置，将自动重试连接");
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
    showProgressNotice("正在导入配置并重启服务…");
    try {
      const result = await desktop.applyConfigImport(preview.import_id);
      await refreshSetup(result.state);
      showSuccessNotice(configImportSuccessMessage(result, preview.unknown_variable_count));
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
    if (activeSettingsSection === "cloud" || activeSettingsSection === "status") return;
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
    const labels = { ziniao: "紫鸟", mabang: "马帮", feishu: "飞书" } as const;
    setConfirmation({ kind: "clear-integration", integration: name, label: labels[name] });
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
      onPasswordChange={setCloudPassword}
      onRetry={() => { void retryCloudConnection(); }}
      onSelect={() => { void selectCloudEnrollment(); }}
      password={cloudPassword}
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
              <p className="desktop-eyebrow">首次启动</p>
              <h1>配置你的 LXE Agent</h1>
              <p className="desktop-onboarding-copy">基础设置完成即可启动，业务集成也可以稍后在设置中补充。</p>
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
            <span>{activeSettingsSection === "cloud" ? "公司云端可以稍后配置" : "基础设置完成后即可启动"}</span>
            {activeSettingsSection !== "cloud" ? (
              <button className="desktop-primary-button" disabled={saving || importApplying} type="submit">
                {importApplying ? "正在应用配置…" : saving ? "正在启动…" : "保存并启动"}
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
      <div key={appGeneration}>{children({ health, openSettings })}</div>
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
                <h2 id="desktop-settings-title">设置</h2>
              </div>
              <button aria-label="关闭设置" className="desktop-close-button" onClick={closeSettings} type="button">
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
              {activeSettingsSection !== "status" && activeSettingsSection !== "cloud" ? (
                <button className="desktop-primary-button" disabled={saving || importApplying} type="submit">
                  {importApplying ? "正在应用配置…" : saving ? "保存中…" : "保存设置"}
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
