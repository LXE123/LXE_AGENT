import { randomUUID } from "node:crypto";
import { BrowserWindow, session, type Cookie, type WebFrameMain } from "electron";
import type { AuthBrowserSession } from "./auth-browser-host";

const accountSelector = "input[type='text'], input[type='tel'], input[placeholder*='手机'], input[placeholder*='账号'], input[name*='account'], input[name*='user']";
const cssSelectors = new Set(["#login-but", "input[type='password']", accountSelector, "a[href*='main.jumpToWms']"]);
const tokenHost = "amz1-private.mabangerp.com";

const allowedNavigation = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (url.hostname === "mabangerp.com" || url.hostname.endsWith(".mabangerp.com"));
  } catch { return false; }
};

export const storageCookie = (cookie: Cookie): Record<string, unknown> => ({
  name: cookie.name, value: cookie.value, domain: cookie.domain ?? "", path: cookie.path ?? "/",
  expires: cookie.session || cookie.expirationDate === undefined ? -1 : cookie.expirationDate,
  httpOnly: cookie.httpOnly ?? false, secure: cookie.secure ?? false,
  sameSite: cookie.sameSite === "strict" ? "Strict" : cookie.sameSite === "no_restriction" ? "None" : "Lax",
});

const timeoutError = (message: string): Error => Object.assign(new Error(message), { name: "TimeoutError" });
const timeoutMs = (value: unknown): number => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 40000) throw new Error("Browser timeout must be between 1 and 40000 ms");
  return Number(value);
};

interface LoginResponse {
  url: string;
  status: number;
  method: string;
  body?: string;
  body_error?: { exception_type: string; message: string };
}

export class ElectronAuthBrowserSession implements AuthBrowserSession {
  readonly window: BrowserWindow;
  private readonly partition = session.fromPartition(`lxe-auth-${randomUUID()}`, { cache: false });
  private readonly origins = new Map<string, { name: string; value: string }[]>();
  private readonly secrets = new Set<string>();
  private lastUrl = "";
  private closed = false;
  private loginResponse: Promise<LoginResponse> | undefined;
  private cancelLoginResponse: (() => void) | undefined;

  constructor(
    headless: boolean,
    private readonly navigationAllowed = allowedNavigation,
    private readonly hosts = { login: "private.mabangerp.com", token: tokenHost },
  ) {
    this.window = new BrowserWindow({
      show: !headless, width: 1920, height: 1080,
      webPreferences: {
        session: this.partition, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, backgroundThrottling: false,
      },
    });
    this.window.setMenuBarVisibility(false);
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guard = (navigation: Electron.Event, url: string): void => {
      if (!this.navigationAllowed(url)) navigation.preventDefault();
    };
    this.window.webContents.on("will-navigate", guard);
    this.window.webContents.on("will-redirect", guard);
    this.window.webContents.on("did-navigate", (_event, url) => { this.lastUrl = url; });
    this.partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.partition.setPermissionCheckHandler(() => false);
  }

  get currentUrl(): string {
    return this.window.isDestroyed() ? this.lastUrl : this.window.webContents.getURL() || this.lastUrl;
  }

  diagnostic(error: unknown): { exception_type: string; message: string } {
    let message = String(error instanceof Error ? error.message : error);
    for (const secret of this.secrets) {
      for (const encoded of [secret, encodeURIComponent(secret)]) message = message.replaceAll(encoded, "[REDACTED]");
    }
    if (message.length > 4000) message = message.slice(0, 3800) + `... [truncated ${message.length - 3800} chars]`;
    return { exception_type: error instanceof Error ? error.name : "Error", message };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cancelLoginResponse?.();
    if (!this.window.isDestroyed()) this.window.destroy();
    try {
      await this.partition.closeAllConnections();
      await this.partition.clearStorageData();
      await this.partition.clearCache();
    } finally {
      this.origins.clear();
      this.secrets.clear();
    }
  }

  private frames(): WebFrameMain[] {
    return this.window.webContents.mainFrame.framesInSubtree.filter(frame => !frame.isDestroyed() && !frame.detached);
  }

  private async captureStorage(): Promise<void> {
    for (const frame of this.frames()) {
      if (!this.navigationAllowed(frame.url)) continue;
      const storage = await frame.executeJavaScript(`(() => ({origin: location.origin, entries: Object.keys(localStorage).map(name => ({name, value: localStorage.getItem(name)}))}))()`) as { origin: string; entries: { name: string; value: string }[] };
      this.origins.set(storage.origin, storage.entries);
    }
  }

  private async navigate(url: string, timeout: number): Promise<void> {
    if (!this.navigationAllowed(url)) throw new Error(`Authentication navigation rejected: ${url}`);
    await this.captureStorage();
    const contents = this.window.webContents;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        contents.removeListener("dom-ready", ready);
        contents.removeListener("destroyed", destroyed);
      };
      const ready = (): void => { cleanup(); resolve(); };
      const destroyed = (): void => { cleanup(); reject(new Error("Authentication window closed during navigation")); };
      const timer = setTimeout(() => { cleanup(); reject(timeoutError(`Navigation DOM wait timed out after ${timeout} ms: ${url}`)); }, timeout);
      contents.once("dom-ready", ready);
      contents.once("destroyed", destroyed);
      void contents.loadURL(url).catch(error => { cleanup(); reject(error); });
    });
  }

  private async element(args: Record<string, unknown>): Promise<unknown> {
    const selector = args.selector as { css?: string; role?: string; name?: string } | undefined;
    if (!selector || !(cssSelectors.has(selector.css ?? "")
      || (selector.role === "textbox" && ["支持手机登陆", "请输入登入密码"].includes(selector.name ?? "")))) {
      throw new Error("Unsupported authentication element selector");
    }
    const action = String(args.action);
    if (!["count", "wait", "fill", "click", "href"].includes(action)) throw new Error("Unsupported authentication element action");
    if (action === "fill") {
      if (typeof args.value !== "string" || args.value.length > 1024) throw new Error("Invalid authentication input");
      if (args.value) this.secrets.add(args.value);
    }
    const wait = ["wait", "fill", "click"].includes(action) ? timeoutMs(args.timeout) : 1;
    const value = await this.window.webContents.executeJavaScript(`(async () => {
      const selector = ${JSON.stringify(selector)}, action = ${JSON.stringify(action)}, value = ${JSON.stringify(args.value ?? "")};
      const find = () => selector.css ? [...document.querySelectorAll(selector.css)] : [...document.querySelectorAll('input')].filter(el => {
        const labelled = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
        const name = el.getAttribute('aria-label') || labelled || [...el.labels || []].map(label => label.textContent.trim()).join(' ') || el.title || el.placeholder;
        return name === selector.name;
      });
      if (action === 'count') return find().length;
      const deadline = Date.now() + ${wait};
      do {
        const el = find()[0];
        const visible = el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        if (el && (action === 'wait' || action === 'href' || (visible && !el.disabled && !el.readOnly))) {
          if (action === 'href') return el.getAttribute('href');
          if (action === 'fill') {
            el.focus();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
          }
          if (action === 'click') el.click();
          return {ready: true};
        }
        if (action === 'href') return null;
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      return {ready: false};
    })()`);
    if (value && typeof value === "object" && value.ready === false) {
      throw timeoutError(`Authentication element ${action} timed out after ${wait} ms: ${JSON.stringify(selector)}`);
    }
    return value;
  }

  private async armLoginResponse(timeout: number): Promise<void> {
    this.cancelLoginResponse?.();
    const debugger_ = this.window.webContents.debugger;
    if (!debugger_.isAttached()) debugger_.attach("1.3");
    await debugger_.sendCommand("Network.enable");
    this.loginResponse = new Promise<LoginResponse>((resolve, reject) => {
      const requests = new Map<string, { url: string; method: string }>();
      let matched: { id: string; response: LoginResponse } | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        debugger_.removeListener("message", listener);
        debugger_.removeListener("detach", detached);
        this.cancelLoginResponse = undefined;
      };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const detached = (_event: Electron.Event, reason: string): void => fail(new Error(`Authentication debugger detached: ${reason}`));
      const listener = async (_event: Electron.Event, method: string, params: Record<string, any>): Promise<void> => {
        if (method === "Network.requestWillBeSent") {
          try {
            const url = new URL(params.request.url);
            if (params.request.method === "POST" && url.hostname === this.hosts.login && url.searchParams.get("mod") === "main.doLogin") {
              requests.set(params.requestId, { url: params.request.url, method: "POST" });
            }
          } catch { /* Non-URL network events cannot be the login request. */ }
        }
        if (method === "Network.responseReceived" && requests.has(params.requestId)) {
          matched = { id: params.requestId, response: { ...requests.get(params.requestId)!, status: params.response.status } };
        }
        if (method === "Network.loadingFailed" && requests.has(params.requestId)) {
          fail(new Error(`Login request failed: ${params.errorText}`));
        }
        if (method === "Network.loadingFinished" && matched && matched.id === params.requestId) {
          const result = matched.response;
          cleanup();
          try {
            const body = await debugger_.sendCommand("Network.getResponseBody", { requestId: matched.id });
            result.body = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
          } catch (error) {
            result.body_error = this.diagnostic(error);
            result.body_error.message = `Network.getResponseBody: ${result.body_error.message}`;
          }
          resolve(result);
        }
      };
      const timer = setTimeout(() => fail(timeoutError(`Login response wait timed out after ${timeout} ms`)), timeout);
      this.cancelLoginResponse = () => fail(new Error("Authentication response capture cancelled"));
      debugger_.on("message", listener);
      debugger_.once("detach", detached);
    });
    // The response may reject between the arm and await RPC calls.
    void this.loginResponse.catch(() => {});
  }

  async invoke(operation: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed || this.window.isDestroyed()) throw new Error("Authentication window is closed");
    switch (operation) {
      case "url": return this.currentUrl;
      case "navigate": await this.navigate(String(args.url), timeoutMs(args.timeout)); return null;
      case "element": return this.element(args);
      case "frames": return this.frames().map(frame => ({ id: frame.frameTreeNodeId, url: frame.url }));
      case "read_storage": {
        const frame = this.frames().find(item => item.frameTreeNodeId === args.frame_id);
        if (!frame) throw new Error("Authentication frame detached");
        const host = new URL(frame.url).hostname;
        if (!(host === this.hosts.token || host.endsWith(`.${this.hosts.token}`)) || args.key !== "freeToken") throw new Error("Unsupported authentication storage target");
        const token = await frame.executeJavaScript("localStorage.getItem('freeToken')");
        await this.captureStorage();
        return token;
      }
      case "cookies": {
        const urls = args.urls;
        if (urls !== null && urls !== undefined && (!Array.isArray(urls) || urls.length !== 1 || !this.navigationAllowed(String(urls[0])))) throw new Error("Invalid authentication cookie URL filter");
        return (await this.partition.cookies.get(Array.isArray(urls) ? { url: String(urls[0]) } : {})).map(storageCookie);
      }
      case "storage_state":
        await this.captureStorage();
        return { cookies: (await this.partition.cookies.get({})).map(storageCookie), origins: [...this.origins].map(([origin, localStorage]) => ({ origin, localStorage })) };
      case "arm_login_response": await this.armLoginResponse(timeoutMs(args.timeout)); return null;
      case "login_response":
        if (!this.loginResponse) throw new Error("Login response capture was not armed");
        return this.loginResponse;
      default: throw new Error(`Unsupported authentication browser operation: ${operation}`);
    }
  }
}
