import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import type { McpLoginTarget } from "@lxe/desktop-protocol";

function webUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("MCP sign-in requires HTTPS or a loopback HTTP URL");
  }
  return url;
}

/** Called only for an explicit desktop login. Discovery, registration, PKCE and the
 * token exchange belong to the SDK. Only the resource's access token leaves here. */
export async function loginToMcp(target: McpLoginTarget, openBrowser: (url: string) => Promise<void>, cancel: AbortSignal): Promise<string> {
  const resource = webUrl(target.url);
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(5 * 60_000)]);
  signal.throwIfAborted();
  const state = randomBytes(32).toString("hex");
  const server = createServer();
  let verifier = "";
  let client: StoredOAuthClientInformation | undefined;
  let tokens: StoredOAuthTokens | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  try {
    const listening = once(server, "listening", { signal });
    server.listen(0, "127.0.0.1");
    await listening;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP login callback is unavailable");
    const callback = new URL("http://127.0.0.1:" + address.port + "/callback");
    const completed = Promise.withResolvers<{ authorizationCode: string; iss?: string }>();
    // A callback or cancellation may arrive while the browser is still being opened.
    void completed.promise.catch(() => {});
    const abort = () => completed.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    server.on("request", (request, response) => {
      const incoming = URL.parse(request.url ?? "/", callback.origin);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      if (!incoming || request.method !== "GET" || request.headers.host !== callback.host || incoming.origin !== callback.origin ||
          incoming.pathname !== callback.pathname || incoming.searchParams.get("state") !== state) {
        response.writeHead(400).end("Invalid login callback.");
        return;
      }
      const code = incoming.searchParams.get("code");
      const error = incoming.searchParams.get("error");
      if (error || !code) {
        response.writeHead(400).end("Sign-in did not complete. Return to LXE Agent.");
        completed.reject(new Error(error ? "MCP authorization: " + error : "MCP login callback is missing the authorization code"));
        return;
      }
      const iss = incoming.searchParams.get("iss");
      response.end("Return to LXE Agent to see the connection status.");
      completed.resolve({ authorizationCode: code, ...(iss && { iss }) });
    });
    const provider: OAuthClientProvider = {
      redirectUrl: callback, clientMetadata: { client_name: "LXE Agent", redirect_uris: [callback.href],
        grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none" },
      state: () => state, clientInformation: () => client, saveClientInformation: value => { client = value; },
      tokens: () => tokens, saveTokens: value => { tokens = value; },
      saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
      saveDiscoveryState: value => { discovery = value; }, discoveryState: () => discovery,
      redirectToAuthorization: async url => { signal.throwIfAborted(); await openBrowser(webUrl(url).href); },
    };
    const options = { serverUrl: resource,
      ...(target.resourceMetadataUrl && { resourceMetadataUrl: webUrl(target.resourceMetadataUrl) }),
      ...(target.scope && { scope: target.scope }),
      fetchFn: (input: string | URL, init?: RequestInit) => fetch(webUrl(input), { ...init, signal, redirect: "error" }),
    };
    try {
      if (await auth(provider, options) === "REDIRECT") {
        signal.throwIfAborted();
        await auth(provider, { ...options, ...await completed.promise });
      }
      signal.throwIfAborted();
      if (!tokens?.access_token || tokens.token_type.toLowerCase() !== "bearer") throw new Error("MCP login did not return a bearer access token");
      return tokens.access_token;
    } finally { signal.removeEventListener("abort", abort); }
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
