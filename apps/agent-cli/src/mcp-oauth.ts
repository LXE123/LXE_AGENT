import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline/promises";
import { auth, fetchToken, OAuthError, refreshAuthorization, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { harnessFetch, type McpOAuthChallenge, type McpOAuthSettings } from "@lxe/runtime";

export type McpGrant = {
  name: string;
  url: string;
  access_token: string;
  expires_at?: number;
  login?: McpOAuthChallenge;
  registration?: StoredOAuthClientInformation;
  renewal?: {
    refresh_token: string;
    issuer: string;
    metadata?: OAuthDiscoveryState["authorizationServerMetadata"];
    client: StoredOAuthClientInformation;
    resource?: string;
  };
};

/** DCR registration survives an unfinished sign-in and does not require tokens. */
export interface McpClientRegistrationStore {
  load(): StoredOAuthClientInformation | undefined;
  save(client: StoredOAuthClientInformation, signal: AbortSignal): Promise<void>;
  invalidate(client: StoredOAuthClientInformation, scope: "client" | "tokens"): Promise<void>;
}

function registeredRedirectUrls(client: StoredOAuthClientInformation | undefined): string[] {
  const urls = client && "redirect_uris" in client ? client.redirect_uris : undefined;
  return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
}

function accessFields(tokens: StoredOAuthTokens) {
  if (!tokens.access_token || tokens.token_type.toLowerCase() !== "bearer") throw new Error("MCP OAuth did not return a bearer access token");
  return { access_token: tokens.access_token,
    ...(tokens.expires_in !== undefined && { expires_at: Date.now() + tokens.expires_in * 1000 }) };
}

export async function renewMcpGrant(grant: McpGrant): Promise<McpGrant> {
  const renewal = grant.renewal;
  if (!renewal) throw new Error("MCP login did not issue a refresh token");
  const signal = AbortSignal.timeout(15_000);
  const tokens = await refreshAuthorization(webUrl(renewal.issuer), {
    clientInformation: renewal.client, refreshToken: renewal.refresh_token,
    ...(renewal.metadata && { metadata: renewal.metadata }), ...(renewal.resource && { resource: renewal.resource }),
    fetchFn: (url, init) => harnessFetch(webUrl(url), { ...init, signal, redirect: "error" }),
  });
  const { expires_at: _oldExpiry, ...rest } = grant;
  return { ...rest, ...accessFields(tokens), renewal: { ...renewal, refresh_token: tokens.refresh_token || renewal.refresh_token } };
}

function webUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("MCP sign-in requires HTTPS or a loopback HTTP URL");
  }
  return url;
}

async function promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined> {
  if (!process.stdin.isTTY) return;
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question("If the browser cannot reach this machine, paste the URL it was redirected to: ", { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally { terminal.close(); }
}

/** Interactive sign-in, explicitly requested by the user. */
export async function loginToMcp(target: McpOAuthChallenge, openBrowser: (url: string) => Promise<void>, signal: AbortSignal,
  settings: McpOAuthSettings = {}, prompt = promptForRedirectUrl,
  registrations?: McpClientRegistrationStore): Promise<Omit<McpGrant, "name">> {
  const resource = webUrl(target.url);
  signal.throwIfAborted();
  const state = randomBytes(32).toString("hex");
  const server = createServer();
  let verifier = "";
  let client: StoredOAuthClientInformation | undefined = settings.clientId
    ? { client_id: settings.clientId, ...(settings.clientSecret && { client_secret: settings.clientSecret }) } : registrations?.load();
  let tokens: StoredOAuthTokens | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  let audience: string | undefined;
  try {
    const registeredRedirect = registeredRedirectUrls(client)[0];
    const registeredUrl = registeredRedirect ? URL.parse(registeredRedirect) : undefined;
    const storedPort = registeredUrl?.protocol === "http:" && registeredUrl.hostname === "127.0.0.1"
      ? Number(registeredUrl.port) || undefined : undefined;
    const listen = async (port: number) => {
      const listening = once(server, "listening", { signal });
      server.listen(port, "127.0.0.1");
      await listening;
    };
    try { await listen(settings.callbackPort ?? storedPort ?? 0); }
    catch (error) {
      // A configured port is required; the previous DCR port is only preferred.
      signal.throwIfAborted();
      if (settings.callbackPort !== undefined || storedPort === undefined) throw error;
      await listen(0);
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP login callback is unavailable");
    const callback = new URL("http://127.0.0.1:" + address.port + "/callback");
    const invalidateClient = async () => {
      if (client && !settings.clientId) await registrations?.invalidate(client, "client");
      if (!settings.clientId) client = undefined;
      tokens = undefined;
    };
    if (client && !settings.clientId && !registeredRedirectUrls(client).includes(callback.href)) {
      await invalidateClient();
    }
    const completed = Promise.withResolvers<{ authorizationCode: string; iss?: string }>();
    // A callback or cancellation may arrive while the browser is still being opened.
    void completed.promise.catch(() => {});
    const abort = () => completed.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const acceptRedirect = (incoming: URL) => {
      if (incoming.origin !== callback.origin || incoming.pathname !== callback.pathname || incoming.searchParams.get("state") !== state) {
        throw new Error("Invalid login callback URL or state");
      }
      const error = incoming.searchParams.get("error"), code = incoming.searchParams.get("code");
      if (error || !code) throw new Error(error ? "MCP OAuth callback error: " + error : "MCP login callback is missing the authorization code");
      const iss = incoming.searchParams.get("iss");
      return { authorizationCode: code, ...(iss && { iss }) };
    };
    server.on("request", (request, response) => {
      const incoming = URL.parse(request.url ?? "/", callback.origin);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      if (!incoming || request.method !== "GET" || request.headers.host !== callback.host || incoming.origin !== callback.origin ||
          incoming.pathname !== callback.pathname || incoming.searchParams.get("state") !== state) {
        response.writeHead(400).end("Invalid login callback.");
        return;
      }
      try {
        completed.resolve(acceptRedirect(incoming));
        response.end("Authorization response received. You can close this tab and return to LXE Agent to check the connection.");
      } catch (error) {
        response.writeHead(400).end("Sign-in did not complete. Return to LXE Agent.");
        completed.reject(error);
      }
    });
    const provider: OAuthClientProvider = {
      redirectUrl: callback,
      get clientMetadata() {
        const supported = discovery?.authorizationServerMetadata?.grant_types_supported;
        return { client_name: settings.clientName ?? "LXE Agent", redirect_uris: [callback.href],
          grant_types: supported && !supported.includes("refresh_token") ? ["authorization_code"] : ["authorization_code", "refresh_token"],
          response_types: ["code"], token_endpoint_auth_method: "none" };
      },
      saveResourceUrl: value => { audience = value; },
      state: () => state,
      clientInformation: async context => {
        // Never send a registration (or its secret) to a different authorization server.
        if (client && !settings.clientId && context && client.issuer !== context.issuer) await invalidateClient();
        return client;
      },
      saveClientInformation: async value => {
        if (!settings.clientId) await registrations?.save(value, signal);
        client = value;
      },
      invalidateCredentials: async scope => {
        if (scope === "all" || scope === "client") await invalidateClient();
        if (scope === "all" || scope === "tokens") {
          if (client && !settings.clientId) await registrations?.invalidate(client, "tokens");
          tokens = undefined;
        }
        if (scope === "all" || scope === "verifier") verifier = "";
        if (scope === "all" || scope === "discovery") discovery = undefined;
      },
      tokens: () => tokens, saveTokens: value => { tokens = value; },
      saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
      saveDiscoveryState: value => { discovery = value; }, discoveryState: () => discovery,
      redirectToAuthorization: async url => { signal.throwIfAborted(); await openBrowser(webUrl(url).href); },
    };
    const options = { serverUrl: resource,
      ...(target.resourceMetadataUrl && { resourceMetadataUrl: webUrl(target.resourceMetadataUrl) }),
      ...(target.scope && { scope: target.scope }),
      fetchFn: (input: string | URL, init?: RequestInit) => harnessFetch(webUrl(input), { ...init, signal, redirect: "error" }),
    };
    try {
      if (await auth(provider, options) === "REDIRECT") {
        signal.throwIfAborted();
        const prompting = new AbortController();
        try {
          void prompt(AbortSignal.any([signal, prompting.signal])).then(value => {
            if (value !== undefined && !prompting.signal.aborted) completed.resolve(acceptRedirect(new URL(value.trim())));
          }).catch(error => completed.reject(error));
          const response = await completed.promise;
          prompting.abort();
          if (!discovery) throw new Error("MCP login authorization server discovery is unavailable");
          try {
            // Exchange against the issuer discovered for this sign-in. Unlike auth(),
            // fetchToken() does not replay a rejected code or replace its actual error.
            tokens = await fetchToken(provider, discovery.authorizationServerUrl, {
              ...response, ...(discovery.authorizationServerMetadata && { metadata: discovery.authorizationServerMetadata }),
              ...(audience && { resource: audience }), fetchFn: options.fetchFn,
            });
          } catch (error) {
            if (error instanceof OAuthError) {
              if (["invalid_client", "unauthorized_client"].includes(error.code)) await provider.invalidateCredentials!("client");
              if (["invalid_client", "unauthorized_client", "invalid_grant", "invalid_dpop_proof"].includes(error.code)) {
                await provider.invalidateCredentials!("tokens");
              }
            }
            throw error;
          }
        } finally { prompting.abort(); }
      }
      signal.throwIfAborted();
      if (!tokens) throw new Error("MCP login did not return tokens");
      return { url: target.url, login: target, ...accessFields(tokens),
        ...(registrations && !settings.clientId && client && { registration: client }),
        ...(tokens.refresh_token && discovery && client && { renewal: {
          refresh_token: tokens.refresh_token, issuer: discovery.authorizationServerUrl, client,
          ...(discovery.authorizationServerMetadata && { metadata: discovery.authorizationServerMetadata }),
          ...(audience && { resource: audience }),
        } }) };
    } finally { signal.removeEventListener("abort", abort); }
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
