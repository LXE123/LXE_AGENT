import { net, type WebContents } from "electron";

// Favicon files can contain several resolutions. Bound the download before it crosses IPC.
const MAX_ICON_BYTES = 256 * 1024;

function fetchIcon(guest: WebContents, raw: string, allowed: (url: string) => string, signal: AbortSignal) {
  const request = net.request({ url: allowed(raw), session: guest.session, credentials: "omit", redirect: "manual" });
  let abort: () => void;
  return new Promise<string | undefined>((resolve, reject) => {
    abort = () => { request.abort(); resolve(undefined); };
    signal.addEventListener("abort", abort, { once: true });
    request.on("error", reject);
    request.on("redirect", (_status, _method, url) => {
      try { allowed(url); request.followRedirect(); }
      catch { abort(); }
    });
    request.on("response", response => {
      response.on("error", reject);
      const mime = String(response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (response.statusCode !== 200 || (mime && !mime.startsWith("image/") && mime !== "application/octet-stream")) {
        abort();
        return;
      }
      const parts: Buffer[] = [];
      let size = 0;
      response.on("data", (part: Buffer) => {
        size += part.length;
        if (size > MAX_ICON_BYTES) abort();
        else parts.push(part);
      });
      response.once("end", () => {
        if (!size || size > MAX_ICON_BYTES) return resolve(undefined);
        const type = mime?.startsWith("image/") ? mime : "image/x-icon";
        resolve(`data:${type};base64,${Buffer.concat(parts, size).toString("base64")}`);
      });
    });
    request.end();
  }).finally(() => signal.removeEventListener("abort", abort));
}

export function watchFavicons(guest: WebContents, allowed: (url: string) => string,
  publish: (data: string | null) => void): void {
  let pending: AbortController | undefined;
  let documentUrl: string | undefined;
  let revision = 0;
  let failed = false;
  let lastCandidates: string[] = [];

  function update(candidates: string[]) {
    const page = URL.parse(guest.getURL());
    if (failed || !page || !["http:", "https:"].includes(page.protocol)) return;
    const urls = [...new Set([...candidates.slice(0, 8).filter(url => url.length <= MAX_ICON_BYTES * 4), new URL("/favicon.ico", page).href])];
    if (urls.length === lastCandidates.length && urls.every((url, i) => url === lastCandidates[i])) return;
    lastCandidates = urls;
    pending?.abort();
    const request = new AbortController();
    pending = request;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    void (async () => {
      let icon: string | undefined;
      for (const raw of urls) {
        if (signal.aborted) break;
        try {
          if (raw.startsWith("data:image/")) {
            icon = raw;
            break;
          }
          icon = await fetchIcon(guest, raw, allowed, signal);
          if (icon) break;
        } catch { /* Try the next advertised icon. A missing image leaves the tab usable. */ }
      }
      if (!request.signal.aborted) publish(icon ?? null);
    })();
  }

  guest.on("did-start-navigation", event => {
    if (event.isMainFrame && !event.isSameDocument) failed = false;
  });
  guest.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (!mainFrame || code === -3) return;
    failed = true;
    revision++;
    pending?.abort();
    publish(null);
  });
  guest.on("did-navigate", (_event, url) => {
    revision++;
    pending?.abort();
    lastCandidates = [];
    if (url !== documentUrl) publish(null);
    documentUrl = url;
  });
  guest.on("page-favicon-updated", (_event, urls) => { revision++; update(urls); });
  guest.on("did-finish-load", () => {
    if (failed || lastCandidates.length || !documentUrl) return;
    // Chromium doesn't repeat the event when the next document declares the same icon.
    const current = revision;
    const code = `Array.from(document.querySelectorAll('link[rel~="icon" i]')).slice(0, 8).map(link => link.href)`;
    void guest.executeJavaScriptInIsolatedWorld(1, [{ code }]).catch(() => [])
      .then((urls: string[]) => { if (current === revision) update(urls); });
  });
  guest.once("destroyed", () => { revision++; pending?.abort(); });
}
