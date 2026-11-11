import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpAuthStore } from "../src/mcp-auth-store";

test("two Harness processes renew a rotating grant once and preserve independent concurrent saves", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-mcp-auth-"));
  const store = new McpAuthStore(root);
  let exchanges = 0;
  const issuer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const form = new URLSearchParams(await request.text());
    exchanges++;
    if (form.get("refresh_token") === "refresh-1" && exchanges === 1) {
      await Bun.sleep(150);
      return Response.json({ token_type: "Bearer", access_token: "access-2", refresh_token: "refresh-2" });
    }
    return Response.json({ error: "invalid_grant", error_description: "revoked refresh-2" }, { status: 400 });
  } });
  const grant = { name: "orders", url: issuer.url.href, access_token: "access-1", expires_at: 1,
    renewal: { issuer: issuer.url.href, client: { client_id: "test" }, refresh_token: "refresh-1" } };
  try {
    await store.save(grant);
    const file = join(root, "config/mcp-auth.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const script = `import { McpAuthStore } from "./apps/agent-cli/src/mcp-auth-store.ts";
      const [root, url, name] = process.argv.slice(1);
      const store = new McpAuthStore(root);
      await store.save({name, url, access_token:"other"});
      if (await store.token("orders", url, "access-1") !== "access-2") process.exit(1);`;
    const children = ["first", "second"].map(name => Bun.spawn([process.execPath, "-e", script, root, grant.url, name]));
    expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
    expect(exchanges).toBe(1);
    for (const name of ["first", "second"]) expect(store.get(name, grant.url)?.access_token).toBe("other");
    expect(store.get("orders", grant.url)?.renewal?.refresh_token).toBe("refresh-2");
    expect(store.get("orders", "https://different.test/")).toBeUndefined();
    await expect(store.token("orders", grant.url, "access-2")).rejects.toThrow("revoked [redacted]");
    expect(store.get("orders", grant.url)?.renewal).toBeUndefined();
    expect(await store.token("orders", grant.url, "access-2")).toBe("access-2");
    expect(exchanges).toBe(2);
    writeFileSync(file, "unparseable secret data");
    await expect(store.save(grant)).rejects.toThrow("Invalid JSON in mcp-auth.json");
    expect(readFileSync(file, "utf8")).toBe("unparseable secret data");
  } finally { issuer.stop(true); rmSync(root, { recursive: true, force: true }); }
});

test("registration invalidation and late token saves cannot replace a newer login or restore a logged-out client", async () => {
  const root = mkdtempSync(join(tmpdir(), "lxe-mcp-registration-store-"));
  const store = new McpAuthStore(root);
  const url = "https://mcp.example.test/", issuer = "https://auth.example.test/";
  const registration = store.clientRegistration("docs", url);
  const first = { client_id: "first", client_secret: "first-secret", issuer, redirect_uris: ["http://127.0.0.1:5001/callback"] };
  const second = { ...first, client_id: "second", client_secret: "second-secret" };
  try {
    await registration.save(first, new AbortController().signal);
    await store.save({ name: "docs", url, registration: first, access_token: "first-token" });
    await new McpAuthStore(root).clientRegistration("docs", url).save(second, new AbortController().signal);
    await registration.invalidate(first, "client");
    await registration.invalidate(first, "tokens");
    await expect(store.save({ name: "docs", url, registration: first, access_token: "late-first-token" })).rejects.toThrow("registration changed");
    expect(registration.load()).toEqual(second);
    expect(store.get("docs", url)).toBeUndefined();
    await store.save({ name: "docs", url, registration: second, access_token: "second-token" });
    await registration.invalidate(second, "tokens");
    expect(registration.load()).toEqual(second);
    expect(store.get("docs", url)).toBeUndefined();
    await store.forget("docs", url);
    await expect(store.save({ name: "docs", url, registration: second, access_token: "late-second-token" })).rejects.toThrow("registration changed");
    expect(registration.load()).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
