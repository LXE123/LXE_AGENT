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
