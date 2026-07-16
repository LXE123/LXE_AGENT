import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ExternalLink,
  FileUp,
  FolderOpen,
  RotateCcw,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import type {
  DesktopConfigImportPreview,
  DesktopHealth,
  DesktopLogProfile,
  DesktopLogRetentionDays,
  DesktopSetupInput,
  DesktopSetupState,
  DesktopZiniaoVersion,
} from "@lxe/desktop-protocol";
import { BrandMark } from "../shared/ui/brand-mark";

type Provider = DesktopSetupInput["provider"];
type IntegrationName = "ziniao" | "mabang" | "feishu";

interface SetupForm {
  provider: Provider;
  apiKey: string;
  workspaceRoot: string;
  ziniaoCompany: string;
  ziniaoUsername: string;
  ziniaoPassword: string;
  ziniaoVersion: DesktopZiniaoVersion;
  ziniaoAppPath: string;
  ziniaoWebDriverPath: string;
  mabangAccount: string;
  mabangPassword: string;
  feishuAppId: string;
  feishuAppSecret: string;
  logProfile: DesktopLogProfile;
  logRetentionDays: DesktopLogRetentionDays;
}

const setupForm = (state: DesktopSetupState): SetupForm => ({
  provider: state.provider as Provider,
  apiKey: "",
  workspaceRoot: state.workspace_root,
  ziniaoCompany: state.ziniao.company,
  ziniaoUsername: state.ziniao.username,
  ziniaoPassword: "",
  ziniaoVersion: state.ziniao.app_version,
  ziniaoAppPath: state.ziniao.app_path,
  ziniaoWebDriverPath: state.ziniao.webdriver_path,
  mabangAccount: state.mabang.account,
  mabangPassword: "",
  feishuAppId: state.feishu.app_id,
  feishuAppSecret: "",
  logProfile: state.logging.profile,
  logRetentionDays: state.logging.retention_days,
});

const stateLabel = (state: DesktopHealth["gateway"]): string => ({
  stopped: "已停止",
  starting: "启动中",
  ready: "运行中",
  error: "异常",
})[state];

const integrationLabel = (managed: boolean, configured: boolean): string =>
  configured ? "已配置" : managed ? "待补全" : "可选";

const hasText = (...values: string[]): boolean => values.some((value) => value.trim().length > 0);

function IntegrationSummary({
  title,
  managed,
  configured,
}: {
  title: string;
  managed: boolean;
  configured: boolean;
}) {
  return (
    <span className="desktop-integration-summary">
      <span>{title}</span>
      <span className={`desktop-integration-status ${configured ? "configured" : managed ? "incomplete" : "optional"}`}>
        {integrationLabel(managed, configured)}
      </span>
    </span>
  );
}

function IntegrationIssues({ issues }: { issues: string[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="desktop-integration-issues">
      {issues.map((issue) => <li key={issue}>{issue}</li>)}
    </ul>
  );
}

function DesktopSettingsForm({
  form,
  setup,
  platform,
  requireKey,
  onChange,
  onSelectWorkspace,
  onSelectConfigImport,
  onSelectZiniaoApp,
  onSelectZiniaoWebDriverDirectory,
  onOpenLogsDirectory,
  onClearIntegration,
}: {
  form: SetupForm;
  setup: DesktopSetupState;
  platform: "win32" | "darwin" | "linux";
  requireKey: boolean;
  onChange: (patch: Partial<SetupForm>) => void;
  onSelectWorkspace: () => void;
  onSelectConfigImport: () => void;
  onSelectZiniaoApp: () => void;
  onSelectZiniaoWebDriverDirectory: () => void;
  onOpenLogsDirectory: () => void;
  onClearIntegration: (name: IntegrationName) => void;
}) {
  return (
    <div className="desktop-setup-fields">
      <section className="desktop-config-import-callout">
        <div>
          <span className="desktop-config-import-icon"><FileUp size={18} /></span>
          <div>
            <h3>已有配置文件？</h3>
            <p>从 `.env` 或 `.env.local` 一键导入；密码只在桌面主进程中读取并加密保存。</p>
          </div>
        </div>
        <button onClick={onSelectConfigImport} type="button">
          <FileUp size={15} />选择文件
        </button>
      </section>
      <section className="desktop-settings-section">
        <div className="desktop-section-heading">
          <div>
            <h3>基础设置</h3>
            <p>启动 LXE Agent 所需的模型与本地工作区。</p>
          </div>
          <span className="desktop-required-badge">必填</span>
        </div>
        <div className="desktop-field-grid">
          <label>
            <span>模型服务</span>
            <select
              value={form.provider}
              onChange={(event) => onChange({ provider: event.target.value as Provider, apiKey: "" })}
            >
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
            <span>默认工作区</span>
            <span className="desktop-path-input">
              <input
                onChange={(event) => onChange({ workspaceRoot: event.target.value })}
                value={form.workspaceRoot}
              />
              <button onClick={onSelectWorkspace} title="选择文件夹" type="button">
                <FolderOpen size={17} />
              </button>
            </span>
          </label>
        </div>
      </section>

      <section className="desktop-settings-section">
        <div className="desktop-section-heading">
          <div>
            <h3>业务集成</h3>
            <p>整组留空即可跳过；开始填写后，该组字段需要完整。</p>
          </div>
          <span className="desktop-optional-badge">可选</span>
        </div>
        <div className="desktop-integrations">
          <details className="desktop-integration-card">
            <summary>
              <IntegrationSummary
                title="紫鸟自动化"
                managed={setup.ziniao.managed}
                configured={setup.ziniao.configured}
              />
            </summary>
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
          </details>

          <details className="desktop-integration-card">
            <summary>
              <IntegrationSummary
                title="马帮"
                managed={setup.mabang.managed}
                configured={setup.mabang.configured}
              />
            </summary>
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
          </details>

          <details className="desktop-integration-card">
            <summary>
              <IntegrationSummary
                title="飞书"
                managed={setup.feishu.managed}
                configured={setup.feishu.configured}
              />
            </summary>
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
          </details>
        </div>
      </section>

      <section className="desktop-settings-section">
        <div className="desktop-section-heading">
          <div>
            <h3>日志与排障</h3>
            <p>标准日志适合长期运行，排障日志仅建议在复现问题时开启。</p>
          </div>
        </div>
        <div className="desktop-field-grid">
          <label>
            <span>日志档位</span>
            <select
              onChange={(event) => onChange({ logProfile: event.target.value as DesktopLogProfile })}
              value={form.logProfile}
            >
              <option value="off">关闭</option>
              <option value="standard">标准</option>
              <option value="diagnostic">排障</option>
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
        <div className="desktop-log-directory">
          <div>
            <span>日志目录</span>
            <code>{setup.logging.directory}</code>
          </div>
          <button onClick={onOpenLogsDirectory} type="button">
            <ExternalLink size={14} />打开目录
          </button>
        </div>
      </section>
    </div>
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
  return (
    <div className="modal-backdrop desktop-config-import-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !applying) onCancel();
    }}>
      <section aria-labelledby="desktop-config-import-title" aria-modal="true" className="desktop-config-import-dialog" role="dialog">
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

export function DesktopShell({
  children,
}: {
  children: (openSettings: () => void) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const desktop = window.lxe?.desktop;
  const [setup, setSetup] = useState<DesktopSetupState | null>(null);
  const [health, setHealth] = useState<DesktopHealth | null>(null);
  const [form, setForm] = useState<SetupForm | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [importPreview, setImportPreview] = useState<DesktopConfigImportPreview | null>(null);
  const [importApplying, setImportApplying] = useState(false);
  const [importDiagnosticConfirmed, setImportDiagnosticConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [appGeneration, setAppGeneration] = useState(0);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void Promise.all([desktop.getSetupState(), desktop.getHealth()]).then(([nextSetup, nextHealth]) => {
      if (cancelled) return;
      setSetup(nextSetup);
      setHealth(nextHealth);
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

  if (!desktop) {
    return <main className="desktop-loading">桌面 preload bridge 不可用，LXE Agent 无法在普通浏览器中运行。</main>;
  }
  const frameClassName = `desktop-window-frame desktop-platform-${desktop.platform}`;
  const dragRegion = <div aria-hidden className="desktop-window-drag-region" />;
  if (!setup || !form) {
    return (
      <main className={`desktop-loading ${frameClassName}`}>
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
    setError("");
    setNotice("");
    try {
      const preview = await desktop.selectConfigImport();
      if (!preview) return;
      setImportPreview(preview);
      setImportDiagnosticConfirmed(false);
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
    setError("");
    try {
      const result = await desktop.applyConfigImport(preview.import_id);
      setImportPreview(null);
      setImportDiagnosticConfirmed(false);
      await refreshSetup(result.state);
      const imported = result.applied_groups.length > 0
        ? `已导入：${result.applied_groups.join("、")}`
        : "配置文件已处理";
      const pending = result.pending_groups.length > 0
        ? `；待补全：${result.pending_groups.join("、")}`
        : "";
      const skipped = preview.unknown_variable_count > 0
        ? `；已跳过 ${preview.unknown_variable_count} 个未知变量`
        : "";
      const warnings = result.warnings.length > 0
        ? `；${result.warnings.length} 项注意事项`
        : "";
      setNotice(`${imported}${pending}${skipped}${warnings}`);
    } catch (cause) {
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
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (form.logProfile === "diagnostic" && setup.logging.profile !== "diagnostic") {
      const confirmed = window.confirm(
        "排障日志可能记录飞书消息正文、账号标识和页面上下文。请仅在复现问题时开启，并在完成后恢复为标准或关闭。是否继续？",
      );
      if (!confirmed) return;
    }
    setSaving(true);
    setError("");
    try {
      await refreshSetup(await desktop.saveSetup(formInput()));
      setSettingsOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const clearIntegration = async (name: IntegrationName): Promise<void> => {
    const labels = { ziniao: "紫鸟", mabang: "马帮", feishu: "飞书" } as const;
    if (!window.confirm(`确定清除${labels[name]}配置并停用该集成吗？保存的密码也会被删除。`)) return;
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
  const settingsFields = (
    <DesktopSettingsForm
      form={form}
      onChange={updateForm}
      onClearIntegration={(name) => { void clearIntegration(name); }}
      onOpenLogsDirectory={() => { void desktop.openLogsDirectory().catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      }); }}
      onSelectConfigImport={() => { void selectConfigImport(); }}
      onSelectWorkspace={() => { void selectWorkspace(); }}
      onSelectZiniaoApp={() => { void selectZiniaoApp(); }}
      onSelectZiniaoWebDriverDirectory={() => { void selectZiniaoWebDriverDirectory(); }}
      platform={desktop.platform}
      requireKey={!setup.provider_key_configured}
      setup={setup}
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

  if (!setup.complete) {
    return (
      <main className={`desktop-onboarding ${frameClassName}`}>
        {dragRegion}
        <form className="desktop-onboarding-card" onSubmit={save}>
          <div className="desktop-onboarding-header">
            <div className="desktop-onboarding-mark"><BrandMark title="LXE Agent" /></div>
            <div>
              <p className="desktop-eyebrow">首次启动</p>
              <h1>配置你的 LXE Agent</h1>
              <p className="desktop-onboarding-copy">基础设置完成即可启动，业务集成也可以稍后在设置中补充。</p>
            </div>
          </div>
          {settingsFields}
          {notice ? <p className="desktop-form-notice">{notice}</p> : null}
          {error ? <p className="desktop-form-error">{error}</p> : null}
          <button className="desktop-primary-button" disabled={saving} type="submit">
            {saving ? "正在启动…" : "保存并启动"}
          </button>
        </form>
        {importDialog}
      </main>
    );
  }

  const openSettings = (): void => {
    setForm(setupForm(setup));
    setError("");
    setSettingsOpen(true);
  };
  const state = health?.gateway ?? "starting";
  return (
    <div className={frameClassName}>
      {dragRegion}
      <div key={appGeneration}>{children(openSettings)}</div>
      {notice && !settingsOpen ? <p className="desktop-import-toast">{notice}</p> : null}
      <button
        className={`desktop-status-button state-${state}`}
        onClick={openSettings}
        title="桌面运行状态与设置"
        type="button"
      >
        <Activity size={15} />
        <span>{stateLabel(state)}</span>
        <Settings size={14} />
      </button>
      {settingsOpen ? (
        <div className="modal-backdrop desktop-settings-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSettingsOpen(false);
        }}>
          <form className="desktop-settings-modal" onSubmit={save}>
            <header>
              <div>
                <p className="desktop-eyebrow">LXE Agent Desktop</p>
                <h2>运行状态与设置</h2>
              </div>
              <button className="desktop-close-button" onClick={() => setSettingsOpen(false)} type="button">
                <X size={18} />
              </button>
            </header>
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
            {health?.message ? <p className="desktop-health-message">{health.message}</p> : null}
            {health ? (
              <details className="desktop-diagnostics">
                <summary>运行目录</summary>
                <dl>
                  <div><dt>资源目录</dt><dd>{health.resource_root}</dd></div>
                  <div><dt>数据目录</dt><dd>{health.data_root}</dd></div>
                  <div><dt>工作区</dt><dd>{health.workspace_root}</dd></div>
                </dl>
              </details>
            ) : null}
            {settingsFields}
            {notice ? <p className="desktop-form-notice">{notice}</p> : null}
            {error ? <p className="desktop-form-error">{error}</p> : null}
            <footer>
              <span className="desktop-version">v{health?.version || "0.1.0"}</span>
              <button disabled={restarting} onClick={() => { void restart(); }} type="button">
                <RotateCcw size={15} />
                {restarting ? "重启中…" : "重启后台"}
              </button>
              <button className="desktop-primary-button" disabled={saving} type="submit">
                {saving ? "保存中…" : "保存设置"}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
      {importDialog}
    </div>
  );
}
