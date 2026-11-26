import type { WebContents } from "electron";

export function browserUrl(raw: string): string {
  const value = raw.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Browser URLs must use HTTP or HTTPS without embedded credentials");
  }
  return url.href;
}

export function browserTimeoutMs(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 40000) {
    throw new Error("Browser timeout must be between 1 and 40000 ms");
  }
  return Number(value);
}

export function browserTimeoutError(message: string): Error {
  return Object.assign(new Error(message), { name: "TimeoutError" });
}

/** Bound native promises whose renderer-side timers cannot run during a page load. */
export async function withinBrowserDeadline<T>(operation: Promise<T>, timeout: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(browserTimeoutError(message)), Math.max(0, timeout));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Wait for DOM readiness, preserving loadURL failures and releasing every listener. */
export async function navigateBrowserPage(contents: WebContents, url: string, timeout: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      contents.off("dom-ready", ready);
      contents.off("destroyed", destroyed);
    };
    const ready = (): void => { cleanup(); resolve(); };
    const destroyed = (): void => { cleanup(); reject(new Error("Browser page closed during navigation")); };
    const timer = setTimeout(() => {
      cleanup();
      reject(browserTimeoutError(`Browser navigation DOM wait timed out after ${timeout} ms: ${url}`));
    }, timeout);
    contents.once("dom-ready", ready);
    contents.once("destroyed", destroyed);
    void contents.loadURL(url).catch(error => { cleanup(); reject(error); });
  });
}
