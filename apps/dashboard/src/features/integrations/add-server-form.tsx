import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { McpServerAddInput } from "@lxe/desktop-protocol";
import { callDashboard } from "../../api/client";
import { queryError } from "../../api/queries";
import { dashboardQueryKeys } from "../../api/query-keys";
import { useUiText } from "../../shared/i18n";

function EntryList({ name, label, first, second }: { name: string; label: string; first: string; second?: string }) {
  const { mcp } = useUiText();
  const nextId = useRef(0);
  const [rows, setRows] = useState<number[]>([]);
  return <fieldset className="mcp-entry-list">
    <legend>{label}</legend>
    {rows.map((id, index) => <div className="mcp-entry-row" key={id}>
      <input name={name} aria-label={`${label} · ${first} ${index + 1}`} placeholder={first} required={name !== "args"} />
      {second && <input name={name + "-value"} aria-label={`${label} · ${second} ${index + 1}`} placeholder={second} required={name === "env_headers"} />}
      <button className="mcp-icon" type="button" onClick={() => setRows(rows.filter(row => row !== id))}
        aria-label={`${mcp.remove} · ${label} ${index + 1}`}><Trash2 size={15} /></button>
    </div>)}
    <button type="button" className="mcp-quiet" onClick={() => setRows([...rows, nextId.current++])}
      aria-label={`${mcp.addRow} · ${label}`}><Plus size={14} />{mcp.addRow}</button>
  </fieldset>;
}

export function McpAddForm({ onClose }: { onClose: () => void }) {
  const { mcp, tools } = useUiText();
  const cache = useQueryClient();
  const [transport, setTransport] = useState<McpServerAddInput["transport"]>("streamable-http");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const data = new FormData(event.currentTarget);
    const field = (name: string) => String(data.get(name) ?? "").trim();
    const values = (name: string) => data.getAll(name).map(String);
    function pairs(name: string) {
      const entries = values(name);
      const vals = values(name + "-value");
      const keys = entries.map(key => key.trim());
      if (new Set(keys).size !== keys.length) throw new Error(mcp.duplicate);
      return new Map(keys.map((key, i) => [key, vals[i]!]));
    }
    setSaving(true);
    setError("");
    try {
      const name = field("name");
      let input: McpServerAddInput;
      if (transport === "stdio") {
        const env = pairs("env");
        for (const item of values("passEnv")) {
          const key = item.trim();
          if (env.has(key)) throw new Error(mcp.duplicate);
          env.set(key, "${" + key + "}");
        }
        input = { name, transport, command: field("command"), args: values("args"), env: Object.fromEntries(env), ...(field("cwd") && { cwd: field("cwd") }) };
      } else {
        input = { name, transport, url: field("url"), ...(field("token") && { bearer_token_env_var: field("token") }),
          headers: Object.fromEntries(pairs("headers")), env_headers: Object.fromEntries(pairs("env_headers")) };
      }
      await callDashboard({ operation: "mcp.servers.add", input });
      await cache.invalidateQueries({ queryKey: dashboardQueryKeys.mcpServers.all });
      onClose();
    } catch (cause) {
      setError(queryError(cause));
    } finally {
      setSaving(false);
    }
  }
  return <form className="mcp-form" onSubmit={save} autoComplete="off">
    <button type="button" className="mcp-quiet" onClick={onClose} disabled={saving}><ArrowLeft size={15} />{mcp.back}</button>
    <h3>{mcp.newTitle}</h3>
    <fieldset className="mcp-form-fields" disabled={saving}>
      <div className="mcp-form-panel">
        <label>{mcp.name}<input autoFocus name="name" required pattern={"[A-Za-z0-9_\\-]+"} placeholder="my-service" aria-describedby="mcp-name-hint" /></label>
        <small id="mcp-name-hint">{mcp.nameHint}</small>
        <fieldset className="mcp-transport"><legend>{mcp.transport}</legend>
          <div>{(["stdio", "streamable-http"] as const).map(kind => <label key={kind}>
            <input type="radio" name="transport" value={kind} checked={transport === kind} onChange={() => { setTransport(kind); setError(""); }} />
            <span>{kind === "stdio" ? mcp.stdio + " (stdio)" : "Streamable HTTP"}</span>
          </label>)}</div>
        </fieldset>
      </div>
      <fieldset className="mcp-form-panel" hidden={transport !== "streamable-http"} disabled={transport !== "streamable-http"}>
        <label>URL<input type="url" name="url" required placeholder="https://example.com/mcp" /></label>
        <details><summary>{mcp.advanced}</summary>
          <label>{mcp.bearer}<input name="token" placeholder="MCP_ACCESS_TOKEN" /></label>
          <EntryList name="headers" label={mcp.headers} first={mcp.key} second={mcp.value} />
          <EntryList name="env_headers" label={mcp.envHeaders} first={mcp.key} second={mcp.variable} />
        </details>
      </fieldset>
      <fieldset className="mcp-form-panel" hidden={transport !== "stdio"} disabled={transport !== "stdio"}>
        <label>{mcp.command}<input name="command" required placeholder="node" /></label>
        <EntryList name="args" label={mcp.args} first={mcp.arg} />
        <details><summary>{mcp.advanced}</summary>
          <label>{mcp.cwd}<input name="cwd" placeholder="/path/to/project" /></label>
          <EntryList name="env" label={mcp.env} first={mcp.key} second={mcp.value} />
          <EntryList name="passEnv" label={mcp.passEnv} first={mcp.variable} />
        </details>
      </fieldset>
    </fieldset>
    {error && <p className="connection-row-error" role="alert">{error}</p>}
    <div className="mcp-form-actions">
      <button type="button" className="mcp-secondary" disabled={saving} onClick={onClose}>{mcp.cancel}</button>
      <button type="submit" className="mcp-primary" disabled={saving}>{saving ? tools.saving : mcp.save}</button>
    </div>
  </form>;
}
