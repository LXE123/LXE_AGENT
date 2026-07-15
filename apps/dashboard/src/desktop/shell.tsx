import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Activity, FolderOpen, RotateCcw, Settings, X } from "lucide-react";
import type {
  DesktopHealth,
  DesktopSetupInput,
  DesktopSetupState,
} from "@lxe/desktop-protocol";

type Provider = DesktopSetupInput["provider"];

interface SetupForm {
  provider: Provider;
  apiKey: string;
  workspaceRoot: string;
  feishuAppId: string;
  feishuAppSecret: string;
}

const setupForm = (state: DesktopSetupState): SetupForm => ({
  provider: state.provider as Provider,
  apiKey: "",
  workspaceRoot: state.workspace_root,
  feishuAppId: "",
  feishuAppSecret: "",
});

const stateLabel = (state: DesktopHealth["gateway"]): string => ({
  stopped: "已停止",
  starting: "启动中",
  ready: "运行中",
  error: "异常",
})[state];

function SetupFields({
  form,
  requireKey,
  onChange,
  onSelectWorkspace,
}: {
  form: SetupForm;
  requireKey: boolean;
  onChange: (patch: Partial<SetupForm>) => void;
  onSelectWorkspace: () => void;
}) {
  return (
    <div className="desktop-setup-fields">
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
          autoComplete="off"
          onChange={(event) => onChange({ apiKey: event.target.value })}
          placeholder={requireKey ? "输入模型 API Key" : "已通过系统安全存储保存"}
          type="password"
          value={form.apiKey}
        />
      </label>
      <label>
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
      <details className="desktop-optional-settings">
        <summary>飞书渠道（可选）</summary>
        <label>
          <span>App ID</span>
          <input
            autoComplete="off"
            onChange={(event) => onChange({ feishuAppId: event.target.value })}
            placeholder="留空则保持现有配置"
            value={form.feishuAppId}
          />
        </label>
        <label>
          <span>App Secret</span>
          <input
            autoComplete="off"
            onChange={(event) => onChange({ feishuAppSecret: event.target.value })}
            placeholder="留空则保持现有配置"
            type="password"
            value={form.feishuAppSecret}
          />
        </label>
      </details>
    </div>
  );
}

export function DesktopShell({
  children,
}: {
  children: (openSettings: () => void) => ReactNode;
}) {
  const desktop = window.lxe?.desktop;
  const [setup, setSetup] = useState<DesktopSetupState | null>(null);
  const [health, setHealth] = useState<DesktopHealth | null>(null);
  const [form, setForm] = useState<SetupForm | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
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

  if (!desktop) return children(() => undefined);
  if (!setup || !form) {
    return <main className="desktop-loading">{error || "正在加载 LXE Agent…"}</main>;
  }

  const updateForm = (patch: Partial<SetupForm>): void => setForm((current) => current ? { ...current, ...patch } : current);
  const selectWorkspace = async (): Promise<void> => {
    const selected = await desktop.selectWorkspace();
    if (selected) updateForm({ workspaceRoot: selected });
  };
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const next = await desktop.saveSetup({
        provider: form.provider,
        ...(form.apiKey ? { api_key: form.apiKey } : {}),
        workspace_root: form.workspaceRoot,
        ...(form.feishuAppId ? { feishu_app_id: form.feishuAppId } : {}),
        ...(form.feishuAppSecret ? { feishu_app_secret: form.feishuAppSecret } : {}),
      });
      setSetup(next);
      setForm(setupForm(next));
      setHealth(await desktop.getHealth());
      setSettingsOpen(false);
      setAppGeneration((value) => value + 1);
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
      setAppGeneration((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestarting(false);
    }
  };

  if (!setup.complete) {
    return (
      <main className="desktop-onboarding">
        <form className="desktop-onboarding-card" onSubmit={save}>
          <div className="desktop-onboarding-mark">LXE</div>
          <div>
            <p className="desktop-eyebrow">首次启动</p>
            <h1>配置你的 LXE Agent</h1>
            <p className="desktop-onboarding-copy">运行时和工具都由桌面程序管理，只需设置模型和工作区。</p>
          </div>
          <SetupFields
            form={form}
            requireKey={!setup.provider_key_configured}
            onChange={updateForm}
            onSelectWorkspace={() => { void selectWorkspace(); }}
          />
          {error ? <p className="desktop-form-error">{error}</p> : null}
          <button className="desktop-primary-button" disabled={saving} type="submit">
            {saving ? "正在启动…" : "保存并启动"}
          </button>
        </form>
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
    <>
      <div key={appGeneration}>{children(openSettings)}</div>
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
                <summary>诊断信息</summary>
                <dl>
                  <div><dt>资源目录</dt><dd>{health.resource_root}</dd></div>
                  <div><dt>数据目录</dt><dd>{health.data_root}</dd></div>
                  <div><dt>工作区</dt><dd>{health.workspace_root}</dd></div>
                </dl>
              </details>
            ) : null}
            <SetupFields
              form={form}
              requireKey={false}
              onChange={updateForm}
              onSelectWorkspace={() => { void selectWorkspace(); }}
            />
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
    </>
  );
}
