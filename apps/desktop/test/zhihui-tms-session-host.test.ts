import { afterEach, describe, expect, test } from "bun:test";
import {
  ZhihuiTmsSessionHost,
  type ZhihuiTmsSessionStore,
} from "../src/main/zhihui-tms-session-host";

const hosts: ZhihuiTmsSessionHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.stop())); });

class FakeStore implements ZhihuiTmsSessionStore {
  readonly values = new Map<string, string>();
  reads = 0;

  read(accountFingerprint: string): string | null {
    this.reads++;
    return this.values.get(accountFingerprint) ?? null;
  }

  save(accountFingerprint: string, apiToken: string): void {
    this.values.set(accountFingerprint, apiToken);
  }

  clear(accountFingerprint: string): void {
    this.values.delete(accountFingerprint);
  }
}

async function fixture() {
  const store = new FakeStore();
  const host = new ZhihuiTmsSessionHost(store);
  hosts.push(host);
  await host.start();
  const environment = host.environment();
  const request = async ({
    operation,
    accountFingerprint = "a".repeat(64),
    apiToken,
    authorization = `Bearer ${environment.LXE_ZHIHUI_TMS_SESSION_HOST_TOKEN}`,
    origin,
    path = "/v1/zhihui-tms-session",
    method = "POST",
  }: {
    operation: string;
    accountFingerprint?: string;
    apiToken?: string;
    authorization?: string;
    origin?: string;
    path?: string;
    method?: string;
  }) => {
    const response = await fetch(`${environment.LXE_ZHIHUI_TMS_SESSION_HOST_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({
        operation,
        account_fingerprint: accountFingerprint,
        ...(apiToken === undefined ? {} : { api_token: apiToken }),
      }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
  };
  return { host, store, request };
}

describe("ZhihuiTmsSessionHost", () => {
  test("rejects unauthenticated and browser-originated requests before reading storage", async () => {
    const { host, request, store } = await fixture();
    expect((await request({ operation: "read", authorization: "Bearer wrong" })).status).toBe(403);
    expect((await request({ operation: "read", origin: "https://untrusted.example" })).status).toBe(403);
    expect(store.reads).toBe(0);
    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);
    expect(() => host.environment()).toThrow("not running");
  });

  test("reads, writes, and clears only valid account fingerprints without caching responses", async () => {
    const { request, store } = await fixture();
    const fingerprint = "b".repeat(64);
    const write = await request({ operation: "write", accountFingerprint: fingerprint, apiToken: "fixture-api-token" });
    expect(write).toMatchObject({ status: 200, body: { ok: true, result: null } });
    expect(write.headers.get("cache-control")).toBe("no-store");
    expect(store.values.get(fingerprint)).toBe("fixture-api-token");

    const read = await request({ operation: "read", accountFingerprint: fingerprint });
    expect(read).toMatchObject({ status: 200, body: { ok: true, result: { api_token: "fixture-api-token" } } });

    const invalid = await request({ operation: "read", accountFingerprint: "invalid" });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(invalid.body)).not.toContain("fixture-api-token");

    expect((await request({ operation: "clear", accountFingerprint: fingerprint })).status).toBe(200);
    expect(store.values.has(fingerprint)).toBeFalse();
  });
});
