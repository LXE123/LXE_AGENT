import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpOAuthSettings } from "@lxe/runtime";
import { McpAuthStore } from "../src/mcp-auth-store";
import { loginToMcp } from "../src/mcp-oauth";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mcp-registration-"));
  const requests = { registrations: 0, tokenClients: [] as string[], callbacks: [] as string[] };
  const state = { issuerPath: "", tokenError: "", requiresIss: false, callbackIssuer: undefined as string | undefined };
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { pathname, origin } = new URL(request.url);
    const issuer = origin + state.issuerPath;
    if (pathname === "/resource") return Response.json({ resource: origin + "/mcp", authorization_servers: [issuer] });
    if (pathname.startsWith("/.well-known/oauth-authorization-server")) return Response.json({ issuer,
      authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", registration_endpoint: issuer + "/register",
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: state.requiresIss });
    if (pathname.endsWith("/register")) {
      requests.registrations++;
      return Response.json({ ...await request.json() as Record<string, unknown>,
        client_id: "registered-" + requests.registrations, client_id_issued_at: 123 }, { status: 201 });
    }
    if (pathname.endsWith("/token")) {
      const form = new URLSearchParams(await request.text());
      requests.tokenClients.push(form.get("client_id")!);
      if (state.tokenError) return Response.json({ error: state.tokenError, error_description: "fixture registration or grant rejected" }, { status: 400 });
      // A registration must be reusable even when no refresh token was issued.
      return Response.json({ access_token: "access-" + requests.tokenClients.length, token_type: "Bearer" });
    }
    return new Response(null, { status: 404 });
  } });
  const target = { url: http.url.origin + "/mcp", resourceMetadataUrl: http.url.origin + "/resource" };
  const store = new McpAuthStore(root);
  const registrations = store.clientRegistration("docs", target.url);
  return { root, target, store, registrations, requests, state,
    async login(settings: McpOAuthSettings = {}, cancel = false) {
      const fresh = new McpAuthStore(root);
      const controller = new AbortController();
      const grant = await loginToMcp(target, async link => {
        const auth = new URL(link);
        const callback = new URL(auth.searchParams.get("redirect_uri")!);
        requests.callbacks.push(callback.href);
        if (!settings.clientId) expect(fresh.clientRegistration("docs", target.url).load()?.client_id).toBe(auth.searchParams.get("client_id")!);
        if (cancel) { controller.abort(new Error("fixture cancelled")); return; }
        callback.searchParams.set("state", auth.searchParams.get("state")!);
        callback.searchParams.set("code", "fixture-code");
        if (state.callbackIssuer) callback.searchParams.set("iss", state.callbackIssuer);
        expect((await fetch(callback)).status).toBe(200);
      }, AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]), settings, async () => undefined,
      fresh.clientRegistration("docs", target.url));
      await fresh.save({ name: "docs", ...grant });
      return grant;
    },
    async close() { await http.stop(true); rmSync(root, { recursive: true, force: true }); },
  };
}

test("DCR persists before browser approval, survives cancellation and token saves, and logout removes it", async () => {
  const f = fixture();
  try {
    await expect(f.login({}, true)).rejects.toThrow("fixture cancelled");
    expect(f.store.get("docs", f.target.url)).toBeUndefined();
    const registered = f.registrations.load()!;
    expect(registered).toMatchObject({ client_id: "registered-1", client_id_issued_at: 123,
      issuer: new URL(f.target.url).origin, redirect_uris: [f.requests.callbacks[0]] });
    if (process.platform !== "win32") expect(statSync(join(f.root, "config/mcp-auth.json")).mode & 0o777).toBe(0o600);
    expect((await f.login()).renewal).toBeUndefined();
    await f.login({ clientName: "Changed name" });
    expect(f.requests.registrations).toBe(1);
    expect(new Set(f.requests.callbacks).size).toBe(1);
    expect(f.requests.tokenClients).toEqual(["registered-1", "registered-1"]);
    expect(f.registrations.load()).toEqual(registered);
    expect(await f.store.forget("docs", f.target.url)).toBe(true);
    expect(f.registrations.load()).toBeUndefined();
    expect(f.store.get("docs", f.target.url)).toBeUndefined();
    await f.login();
    expect(f.requests.registrations).toBe(2);
  } finally { await f.close(); }
});

test("an occupied previous callback port falls back and registers again; a configured occupied port fails", async () => {
  const f = fixture();
  let occupied: ReturnType<typeof Bun.serve> | undefined;
  try {
    await f.login();
    const port = Number(new URL(f.requests.callbacks[0]!).port);
    occupied = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(null) });
    await f.login();
    expect(f.requests.callbacks[1]).not.toBe(f.requests.callbacks[0]);
    expect(f.requests.registrations).toBe(2);
    await expect(f.login({ callbackPort: port })).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(f.requests.registrations).toBe(2);
  } finally { await occupied?.stop(true); await f.close(); }
});

test("a changed callback port replaces registration while an explicit client bypasses DCR", async () => {
  const f = fixture();
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  try {
    await f.login();
    const callbackPort = reservation.port!;
    await reservation.stop(true);
    await expect(f.login({ callbackPort }, true)).rejects.toThrow("fixture cancelled");
    expect(new URL(f.requests.callbacks[1]!).port).toBe(String(callbackPort));
    expect(f.requests.registrations).toBe(2);
    expect(f.store.get("docs", f.target.url)).toBeUndefined();
    const registration = f.registrations.load();
    await f.login({ clientId: "configured-client" });
    expect(f.requests.tokenClients.at(-1)).toBe("configured-client");
    expect(f.requests.registrations).toBe(2);
    expect(f.registrations.load()).toEqual(registration);
  } finally { await reservation.stop(true); await f.close(); }
});

test("a changed authorization server cannot receive the previous server's registered client", async () => {
  const f = fixture();
  try {
    await f.login();
    f.state.issuerPath = "/another-issuer";
    await f.login();
    expect(f.requests.registrations).toBe(2);
    expect(f.requests.tokenClients).toEqual(["registered-1", "registered-2"]);
    expect(f.registrations.load()?.issuer).toBe(new URL(f.target.url).origin + "/another-issuer");
  } finally { await f.close(); }
});

for (const error of ["invalid_grant", "invalid_client", "unauthorized_client"]) {
  test(`${error} refresh failure ${error === "invalid_grant" ? "keeps" : "discards"} the DCR registration`, async () => {
    const f = fixture();
    try {
      const grant = await f.login();
      const client = f.registrations.load()!;
      const issuer = new URL(f.target.url).origin;
      await f.store.save({ name: "docs", ...grant, renewal: { client, issuer, refresh_token: "fixture-refresh",
        metadata: { issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", response_types_supported: ["code"] } } });
      f.state.tokenError = error;
      await expect(f.store.token("docs", f.target.url, grant.access_token)).rejects.toThrow("fixture registration or grant rejected");
      expect(f.registrations.load()).toEqual(error === "invalid_grant" ? client : undefined);
      f.state.tokenError = "";
      await f.login();
      expect(f.requests.registrations).toBe(error === "invalid_grant" ? 1 : 2);
    } finally { await f.close(); }
  });
}

test("a failed code exchange invalidates the rejected client before the next login", async () => {
  const f = fixture();
  try {
    f.state.tokenError = "invalid_client";
    await expect(f.login()).rejects.toThrow("fixture registration or grant rejected");
    expect(f.requests.tokenClients).toHaveLength(1);
    expect(f.registrations.load()).toBeUndefined();
    f.state.tokenError = "";
    await f.login();
    expect(f.requests.registrations).toBe(2);
  } finally { await f.close(); }
});

test("code exchange rejects a missing or foreign issuer before sending the code", async () => {
  const f = fixture();
  try {
    f.state.requiresIss = true;
    await expect(f.login()).rejects.toThrow("Issuer mismatch");
    f.state.callbackIssuer = "https://different.example.test";
    await expect(f.login()).rejects.toThrow("Issuer mismatch");
    expect(f.requests.tokenClients).toHaveLength(0);
    f.state.callbackIssuer = new URL(f.target.url).origin;
    await f.login();
    expect(f.requests.registrations).toBe(1);
    expect(f.requests.tokenClients).toEqual(["registered-1"]);
  } finally { await f.close(); }
});
