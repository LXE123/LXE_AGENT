import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { loginToMcp, renewMcpGrant } from "../src/mcp-oauth";

test("interactive MCP login binds the callback state and uses PKCE before returning a bearer token", async () => {
  let redirect = "", challenge = "", exchanged = 0;
  const issuer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const { origin, pathname } = new URL(req.url);
    if (pathname === "/resource-metadata") return Response.json({ resource: origin + "/mcp", authorization_servers: [origin] });
    if (pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin,
      authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", registration_endpoint: origin + "/register",
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] });
    if (pathname === "/register") {
      const data = await req.json() as { redirect_uris: string[] };
      redirect = data.redirect_uris[0]!;
      return Response.json({ ...data, client_id: "public-client" }, { status: 201 });
    }
    if (pathname === "/token") {
      const params = new URLSearchParams(await req.text());
      if (params.get("grant_type") === "refresh_token") {
        expect(params.get("refresh_token")).toBe("first-refresh");
        expect(params.get("resource")).toBe(origin + "/mcp");
        expect(params.get("client_id")).toBe("public-client");
        return Response.json({ access_token: "second-access", refresh_token: "second-refresh", token_type: "Bearer", expires_in: 120 });
      }
      expect(params.get("redirect_uri")).toBe(redirect);
      expect(params.get("code")).toBe("approved");
      expect(createHash("sha256").update(params.get("code_verifier")!).digest("base64url")).toBe(challenge);
      exchanged++;
      return Response.json({ access_token: "fixture-access", refresh_token: "first-refresh", token_type: "Bearer", expires_in: 1 });
    }
    return new Response(null, { status: 404 });
  } });
  const target = { url: issuer.url.origin + "/mcp", resourceMetadataUrl: issuer.url.origin + "/resource-metadata", scope: "orders.read" };
  try {
    const token = await loginToMcp(target, async link => {
      const auth = new URL(link);
      expect(auth.pathname).toBe("/authorize");
      expect(auth.searchParams.get("scope")).toBe("orders.read");
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      challenge = auth.searchParams.get("code_challenge")!;
      const callback = new URL(redirect);
      callback.searchParams.set("code", "approved");
      expect((await fetch(callback)).status).toBe(400);
      expect(exchanged).toBe(0);
      callback.searchParams.set("state", auth.searchParams.get("state")!);
      expect((await fetch(callback)).ok).toBe(true);
    }, new AbortController().signal);
    const grant = { name: "orders", ...token };
    expect(grant.access_token).toBe("fixture-access");
    expect(typeof grant.expires_at).toBe("number");
    const renewed = await renewMcpGrant(grant);
    expect(renewed.renewal?.refresh_token).toBe("second-refresh");
    expect(renewed.expires_at!).toBeGreaterThan(grant.expires_at!);
    expect(renewed.access_token).toBe("second-access");
    expect(exchanged).toBe(1);

    const cancel = new AbortController();
    await expect(loginToMcp(target, async () => { cancel.abort(new Error("user cancelled")); }, cancel.signal)).rejects.toThrow("user cancelled");
    expect(exchanged).toBe(1);
  } finally { issuer.stop(true); }
});

for (const staticClient of [false, true]) {
  test(`${staticClient ? "pre-registered" : "DCR"} OAuth settings and pasted callbacks use the actual authorization exchange`, async () => {
    let registrations = 0, exchanges = 0, redirect: URL | undefined, promptSignal: AbortSignal | undefined;
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const callbackPort = reserved.port!;
    await reserved.stop(true);
    const issuer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const { origin, pathname } = new URL(request.url);
      if (pathname === "/resource") return Response.json({ resource: origin + "/mcp", authorization_servers: [origin] });
      if (pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: origin,
        authorization_endpoint: origin + "/authorize", token_endpoint: origin + "/token", registration_endpoint: origin + "/register",
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic", "none"] });
      if (pathname === "/register") {
        registrations++;
        const data = await request.json() as { client_name: string; redirect_uris: string[] };
        expect(data.client_name).toBe("Fixture application");
        expect(data.redirect_uris).toEqual([`http://127.0.0.1:${callbackPort}/callback`]);
        return Response.json({ ...data, client_id: "fixture-dcr" }, { status: 201 });
      }
      if (pathname === "/token") {
        exchanges++;
        const data = new URLSearchParams(await request.text());
        expect(data.get("code")).toBe("pasted-code");
        expect(data.get("redirect_uri")).toBe(`http://127.0.0.1:${callbackPort}/callback`);
        if (staticClient) expect(request.headers.get("authorization")).toBe("Basic " + btoa("fixture-client:fixture-secret"));
        else expect(data.get("client_id")).toBe("fixture-dcr");
        return Response.json({ access_token: "fixture-pasted-token", token_type: "Bearer" });
      }
      return new Response(null, { status: 404 });
    } });
    const target = { url: issuer.url.origin + "/mcp", resourceMetadataUrl: issuer.url.origin + "/resource" };
    const settings = { callbackPort, clientName: "Fixture application", clientRegistration: "dcr" as const,
      ...(staticClient && { clientId: "fixture-client", clientSecret: "fixture-secret" }) };
    const open = async (link: string) => {
      const auth = new URL(link);
      redirect = new URL(auth.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", auth.searchParams.get("state")!);
      redirect.searchParams.set("code", "pasted-code");
    };
    try {
      const grant = await loginToMcp(target, open, AbortSignal.timeout(5_000), settings, async signal => { promptSignal = signal; return redirect!.href; });
      expect(grant.access_token).toBe("fixture-pasted-token");
      expect(registrations).toBe(staticClient ? 0 : 1);
      expect(promptSignal?.aborted).toBe(true);
      for (const invalid of ["state", "origin"]) {
        await expect(loginToMcp(target, open, AbortSignal.timeout(5_000), settings, async () => {
          if (invalid === "state") redirect!.searchParams.set("state", "wrong");
          else redirect!.hostname = "localhost";
          return redirect!.href;
        })).rejects.toThrow("Invalid login callback URL or state");
      }
      expect(exchanges).toBe(1);
      await expect(fetch(`http://127.0.0.1:${callbackPort}/callback`)).rejects.toThrow();
    } finally { issuer.stop(true); }
  });
}
