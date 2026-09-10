import { afterEach, describe, expect, test } from "bun:test";
import { AuthBrowserHost, type AuthBrowserSession } from "../src/main/auth-browser-host";

const hosts: AuthBrowserHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.stop())); });

class FakeSession implements AuthBrowserSession {
  currentUrl = "https://private.mabangerp.com/";
  closed = 0;
  operations: string[] = [];
  async invoke(operation: string): Promise<unknown> {
    this.operations.push(operation);
    if (operation === "fail") throw new TypeError("actual browser failure");
    return "value";
  }
  async close(): Promise<void> { this.closed++; }
  diagnostic(error: unknown) {
    return { exception_type: (error as Error).name, message: (error as Error).message };
  }
}

async function fixture(idleMs = 180_000) {
  const sessions: FakeSession[] = [];
  const host = new AuthBrowserHost(async () => {
    const session = new FakeSession();
    sessions.push(session);
    return session;
  }, idleMs);
  hosts.push(host);
  await host.start();
  const env = host.environment();
  const call = async (operation: string, id = "", headers: Record<string, string> = {}) => {
    const response = await fetch(env.LXE_AUTH_BROWSER_HOST_URL + "/v1/auth-browser", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LXE_AUTH_BROWSER_HOST_TOKEN}`, ...headers },
      body: JSON.stringify({ operation, session_id: id, arguments: { headless: true } }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { host, call, sessions, env };
}

describe("authentication browser host", () => {
  test("authenticates before creating any page, rejects browser origins", async () => {
    const { call, sessions } = await fixture();
    expect((await call("open", "", { Authorization: "Bearer wrong" })).status).toBe(403);
    expect((await call("open", "", { Origin: "https://untrusted.example" })).status).toBe(403);
    expect(sessions).toHaveLength(0);
  });

  test("isolates sessions and returns actual typed failures", async () => {
    const { call, sessions } = await fixture();
    const first = (await call("open")).body.result.session_id;
    const second = (await call("open")).body.result.session_id;
    expect(first).not.toBe(second);
    expect((await call("url", first)).body.result).toBe("value");
    const failure = (await call("fail", second)).body;
    expect(failure).toMatchObject({ ok: false, error: { exception_type: "TypeError", message: "actual browser failure" } });
    expect(sessions[0]!.operations).toEqual(["url"]);
    expect(sessions[1]!.operations).toEqual(["fail"]);
    await call("close", first);
    expect(sessions[0]!.closed).toBe(1);
    expect((await call("url", first)).body.ok).toBe(false);
    expect(sessions[1]!.closed).toBe(0);
  });

  test("cleans idle sessions and closes active sessions at shutdown", async () => {
    const { host, call, sessions } = await fixture(25);
    await call("open");
    const deadline = Date.now() + 1000;
    while (!sessions[0]!.closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(sessions[0]!.closed).toBe(1);
    await call("open");
    await host.stop();
    hosts.splice(hosts.indexOf(host), 1);
    expect(sessions[1]!.closed).toBe(1);
    expect(() => host.environment()).toThrow("not running");
  });

  // Disconnect cleanup runs in the native Electron fixture: Electron uses Node HTTP,
  // whose socket lifecycle differs from Bun's node:http compatibility layer.
});
