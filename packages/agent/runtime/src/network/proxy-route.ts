import { BlockList, isIP } from "node:net";
import { httpProxyUrl, type ManualSystemProxy } from "./system-proxy";

type Environment = Record<string, string | undefined>;
export type ProxyRoute = { proxy: string | false; source: "environment" | "system" | "bypass" | "direct" };
const hostname = (host: string): string => host.replace(/^\[|\]$/gu, "").replace(/\.$/u, "").toLowerCase();

export function isLoopback(url: URL): boolean {
  const host = hostname(url.hostname);
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

export function bypassesProxy(url: URL, patterns: string[], environment = false): boolean {
  const host = hostname(url.hostname);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return patterns.some(pattern => {
    let entry = pattern.trim().toLowerCase();
    if (!entry) return false;
    if (entry === "*") return true;
    if (entry === "<local>") return !isIP(host) && !host.includes(".");
    if (entry.includes("/")) {
      const [network, prefix] = entry.split("/");
      const family = isIP(network!);
      if (!family || isIP(host) !== family || !/^\d+$/u.test(prefix ?? "")) return false;
      try {
        const block = new BlockList();
        block.addSubnet(network!, Number(prefix), family === 4 ? "ipv4" : "ipv6");
        return block.check(host, family === 4 ? "ipv4" : "ipv6");
      } catch { return false; }
    }
    const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/u.exec(entry);
    if (withPort) {
      if (withPort[2] !== port) return false;
      entry = withPort[1]!;
    }
    entry = hostname(entry);
    if (environment && !isIP(entry)) {
      const domain = entry.replace(/^(?:\*\.)?\.?/u, "");
      return host === domain || host.endsWith(`.${domain}`);
    }
    if (entry.startsWith(".")) return host.endsWith(entry) || host === entry.slice(1);
    const glob = entry.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
    return new RegExp(`^${glob}$`, "u").test(host);
  });
}

/** Explicit environment choices (including NO_PROXY) precede system settings. */
export function environmentRoute(url: URL, env: Environment): ProxyRoute | undefined {
  const bypass = env.no_proxy || env.NO_PROXY || "";
  if (isLoopback(url) || bypassesProxy(url, bypass.split(/[,\s]+/u), true)) return { proxy: false, source: "bypass" };
  const key = url.protocol === "https:" ? "https_proxy" : "http_proxy";
  const specific = env[key] || env[key.toUpperCase()];
  const fallback = env.all_proxy || env.ALL_PROXY;
  // Like Bun's HTTP transport, do not treat a SOCKS-only ALL_PROXY as an HTTP proxy.
  const value = specific || (fallback && !/^(?!https?:)[a-z][a-z\d+.-]*:\/\//iu.test(fallback) ? fallback : undefined);
  return value?.trim() ? { proxy: httpProxyUrl(value.trim()), source: "environment" } : undefined;
}

export function systemRoute(url: URL, settings: ManualSystemProxy): ProxyRoute {
  if (bypassesProxy(url, settings.bypass)) return { proxy: false, source: "bypass" };
  const proxy = url.protocol === "https:" ? settings.https : settings.http;
  return proxy ? { proxy, source: "system" } : { proxy: false, source: "direct" };
}
