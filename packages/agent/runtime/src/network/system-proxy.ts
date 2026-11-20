import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

export interface ManualSystemProxy {
  http?: string;
  https?: string;
  bypass: string[];
}

const execute = promisify(execFile);

/** Only HTTP proxy transports; HTTPS destinations normally use an HTTP CONNECT proxy. */
export function httpProxyUrl(value: string): string {
  const url = new URL(value.includes("://") ? value : `http://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Expected an HTTP/HTTPS proxy address without a path, query or fragment");
  }
  return url.href;
}

/** Read only the global dictionary, not unrelated scoped/supplemental interfaces. */
export function parseMacSystemProxy(output: string): ManualSystemProxy {
  if (!output.trim().startsWith("<dictionary> {")) throw new Error("Invalid scutil --proxy response");
  const fields = new Map<string, string>();
  const bypass: string[] = [];
  let depth = 0;
  let exceptions = false;
  for (const line of output.split(/\r?\n/u)) {
    const text = line.trim();
    if (text.endsWith("{")) {
      if (depth === 1 && text.startsWith("ExceptionsList :")) exceptions = true;
      depth++;
    } else if (text === "}") {
      if (depth === 2) exceptions = false;
      depth--;
    } else {
      const pair = /^(\S+)\s+:\s+(.*)$/u.exec(text);
      if (pair && depth === 1) fields.set(pair[1]!, pair[2]!);
      else if (pair && depth === 2 && exceptions) bypass.push(pair[2]!);
    }
  }
  if (depth !== 0) throw new Error("Incomplete scutil --proxy response");
  if (fields.get("ExcludeSimpleHostnames") === "1") bypass.push("<local>");
  const proxy = (kind: "HTTP" | "HTTPS"): string | undefined => {
    if (fields.get(`${kind}Enable`) !== "1") return undefined;
    const host = fields.get(`${kind}Proxy`);
    const port = Number(fields.get(`${kind}Port`));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid system ${kind} proxy host or port`);
    return httpProxyUrl(`${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`);
  };
  const http = proxy("HTTP"), https = proxy("HTTPS");
  return { ...(http && { http }), ...(https && { https }), bypass };
}

export function parseWindowsSystemProxy(output: string): ManualSystemProxy {
  const settings = JSON.parse(output) as { ProxyEnable?: number; ProxyServer?: string; ProxyOverride?: string };
  if (!settings.ProxyEnable) return { bypass: [] };
  const value = settings.ProxyServer?.trim();
  if (!value) throw new Error("Enabled Windows system proxy is missing ProxyServer");
  const bypass = (settings.ProxyOverride ?? "").split(";").map(value => value.trim()).filter(Boolean);
  if (!value.includes("=")) return { http: httpProxyUrl(value), https: httpProxyUrl(value), bypass };
  const proxies = new Map(value.split(";").map(entry => {
    const separator = entry.indexOf("=");
    return [entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim()];
  }));
  return { bypass, ...(proxies.has("http") && { http: httpProxyUrl(proxies.get("http")!) }),
    ...(proxies.has("https") && { https: httpProxyUrl(proxies.get("https")!) }) };
}

// Fixed read-only command; JSON and UTF-8 avoid localized reg.exe output/code pages.
const WINDOWS_PROXY_QUERY = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference = 'Stop';
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
if (Test-Path $path) { Get-ItemProperty -LiteralPath $path | Select-Object ProxyEnable, ProxyServer, ProxyOverride | ConvertTo-Json -Compress } else { '{}' }`;

export async function readManualSystemProxy(): Promise<ManualSystemProxy> {
  if (process.platform === "darwin") {
    const { stdout } = await execute("/usr/sbin/scutil", ["--proxy"], { timeout: 3_000, maxBuffer: 128 * 1024 });
    return parseMacSystemProxy(stdout);
  }
  if (process.platform === "win32") {
    const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await execute(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROXY_QUERY],
      { timeout: 3_000, maxBuffer: 128 * 1024, windowsHide: true });
    return parseWindowsSystemProxy(stdout.replace(/^\uFEFF/u, ""));
  }
  return { bypass: [] };
}

/** Cache both successful reads and failures briefly; concurrent callers share the same query. */
export function cachedSystemProxy(read = readManualSystemProxy, now = Date.now): () => Promise<ManualSystemProxy> {
  let pending: Promise<ManualSystemProxy> | undefined;
  let expiresAt = 0;
  return () => {
    if (!pending || now() >= expiresAt) {
      expiresAt = now() + 5_000;
      pending = Promise.resolve().then(read);
    }
    return pending;
  };
}
