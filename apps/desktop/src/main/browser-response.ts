/** Shared page-response capture; URL/method matching is supplied by the business caller. */
import type { WebContents } from "electron";
import { browserTimeoutError as timeoutError, withinBrowserDeadline } from "./browser-navigation";

export interface BrowserResponse {
  url: string;
  status: number;
  method: string;
  body?: string;
  body_error?: { exception_type: string; message: string };
}

export async function armBrowserResponse(
  contents: WebContents,
  timeout: number,
  matches: (url: URL, method: string) => boolean,
  diagnostic: (error: unknown) => { exception_type: string; message: string },
) {
  let ownsDebugger = false;
  let cancel = (): void => {};
  const deadline = Date.now() + timeout;
  const waitForSetup = <T>(operation: Promise<T>): Promise<T> => withinBrowserDeadline(
    operation,
    deadline - Date.now(),
    `Browser response setup exceeded host deadline of ${timeout} ms`,
  );
  // A fresh BrowserWindow has no renderer target yet; Network.enable can stall before the first navigation.
  if (!contents.getURL()) await waitForSetup(contents.loadURL("about:blank"));
  const debugger_ = contents.debugger;
  if (!debugger_.isAttached()) {
    debugger_.attach("1.3");
    ownsDebugger = true;
  }
  try {
    await waitForSetup(debugger_.sendCommand("Network.enable"));
  } catch (error) {
    if (ownsDebugger && !contents.isDestroyed() && debugger_.isAttached()) debugger_.detach();
    throw error;
  }
  const response = new Promise<BrowserResponse>((resolve, reject) => {
    const requests = new Map<string, { url: string; method: string }>();
    let matched: { id: string; response: BrowserResponse } | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      debugger_.removeListener("message", listener);
      debugger_.removeListener("detach", detached);
    };
    const fail = (error: Error): void => { cleanup(); reject(error); };
    const detached = (_event: Electron.Event, reason: string): void => fail(new Error(`Authentication debugger detached: ${reason}`));
    const listener = async (_event: Electron.Event, method: string, params: Record<string, any>): Promise<void> => {
      if (method === "Network.requestWillBeSent") {
        try {
          const url = new URL(params.request.url);
          if (matches(url, params.request.method)) {
            requests.set(params.requestId, { url: params.request.url, method: params.request.method });
          }
        } catch { /* Non-URL network events cannot be the login request. */ }
      }
      if (method === "Network.responseReceived" && requests.has(params.requestId)) {
        matched = { id: params.requestId, response: { ...requests.get(params.requestId)!, status: params.response.status } };
      }
      if (method === "Network.loadingFailed" && requests.has(params.requestId)) {
        fail(new Error(`Browser request failed: ${params.errorText}`));
      }
      if (method === "Network.loadingFinished" && matched && matched.id === params.requestId) {
        const result = matched.response;
        cleanup();
        try {
          const body = await withinBrowserDeadline(
            debugger_.sendCommand("Network.getResponseBody", { requestId: matched.id }),
            deadline - Date.now(),
            `Network.getResponseBody exceeded host deadline of ${timeout} ms`,
          );
          result.body = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
        } catch (error) {
          result.body_error = diagnostic(error);
          result.body_error.message = `Network.getResponseBody: ${result.body_error.message}`;
        }
        resolve(result);
      }
    };
    const timer = setTimeout(() => fail(timeoutError(`Browser response wait timed out after ${timeout} ms`)),
      Math.max(0, deadline - Date.now()));
    cancel = () => fail(new Error("Browser response capture cancelled"));
    debugger_.on("message", listener);
    debugger_.once("detach", detached);
  });
  // The response may reject between the arm and await RPC calls.
  void response.catch(() => {});
  return { response, cancel, ownsDebugger };
}
