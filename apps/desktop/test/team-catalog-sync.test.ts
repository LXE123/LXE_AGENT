import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardTransport, SkillPayload, TeamCatalogSnapshot } from "@lxe/desktop-protocol";
import { TeamCatalogSyncService, parseTeamCatalogSettings } from "../src/main/team-catalog-sync";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const secure = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(Buffer.from(value).toString("base64")),
  decryptString: (value: Buffer) => Buffer.from(value.toString(), "base64").toString(),
};
const settings = { endpoint: "https://example.aiforce.cloud/openapi/lxe/catalog/sync", sourceLabel: "目录发布机", apiKey: "private-test-key" };
const skill: SkillPayload = { name: "example", description: "真实技能说明", type: "default", source: "user", location: "/private/skill", commands: ["secret-command"], references: [{ path: "secret.md", description: "private reference" }] };
function fixture(request: (url: string | URL | Request, init?: RequestInit) => Promise<Response>, available = () => [skill]) {
  const path = mkdtempSync(join(tmpdir(), "lxe-team-catalog-")); directories.push(path);
  const calls: unknown[] = [];
  const dashboard = { call: async (call: unknown) => { calls.push(call); const items = available(); return { items, total: items.length }; } } as DashboardTransport;
  const service = new TeamCatalogSyncService(path, secure, dashboard, request as typeof fetch);
  return { service, path, calls };
}
function success(snapshot: TeamCatalogSnapshot) {
  return Response.json({ sourceId: snapshot.sourceId, revision: snapshot.revision, skillCount: snapshot.skills.length, receivedAt: "2026-10-21T10:00:00.000Z" });
}

describe("manual team directory sync", () => {
  test("queries the runtime on each sync and only publishes allowlisted metadata, including an empty replacement", async () => {
    const sent: TeamCatalogSnapshot[] = [];
    let available = [skill];
    const { service, path, calls } = fixture(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${settings.apiKey}`);
      const snapshot = JSON.parse(String(init?.body)); sent.push(snapshot); return success(snapshot);
    }, () => available);
    expect(service.state().configured).toBe(false);
    service.save(settings);
    await service.sync(); available = []; await service.sync();
    expect(calls).toEqual([{ operation: "skills.list", input: {} }, { operation: "skills.list", input: {} }]);
    expect(sent[0]?.skills).toEqual([{ name: "example", description: "真实技能说明", type: "default", source: "user" }]);
    expect(sent[1]?.skills).toEqual([]);
    expect(sent[1]?.revision).toBe(2);
    expect(service.state().lastSync?.skillCount).toBe(0);
    expect(JSON.stringify(service.state())).not.toContain(settings.apiKey);
    expect(readFileSync(join(path, "config", "team-catalog.bin"), "utf8")).not.toContain(settings.apiKey);
    const reopened = new TeamCatalogSyncService(path, secure, {} as DashboardTransport);
    expect(reopened.state().sourceId).toBe(service.state().sourceId);
  });

  test("preserves successful receipt on HTTP failure, exposes actual error and redacts the key", async () => {
    let failed = false;
    const { service } = fixture(async (_url, init) => failed
      ? new Response(`source conflict: ${settings.apiKey}`, { status: 409 })
      : success(JSON.parse(String(init?.body))));
    service.save(settings); await service.sync(); const receipt = service.state().lastSync; failed = true;
    await expect(service.sync()).rejects.toThrow("HTTP 409: source conflict: [redacted]");
    expect(service.state().lastSync).toEqual(receipt);
    expect(service.state().syncing).toBe(false);
  });

  test("rejects a success response that does not acknowledge the uploaded snapshot", async () => {
    const { service } = fixture(async () => Response.json({ ok: true })); service.save(settings);
    await expect(service.sync()).rejects.toThrow("invalid synchronization receipt");
    expect(service.state().lastSync).toBeNull();
  });

  test("blocks simultaneous uploads and config changes until the active upload finishes", async () => {
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const { service } = fixture(async (_url, init) => { await wait; return success(JSON.parse(String(init?.body))); });
    service.save(settings); const running = service.sync();
    await expect(service.sync()).rejects.toThrow("already running");
    expect(() => service.save(settings)).toThrow("current synchronization");
    finish(); await running;
  });

  test("does not reuse a credential for a changed destination or save it without secure storage", () => {
    const { service, path } = fixture(async () => new Response()); service.save(settings);
    expect(() => service.save({ ...settings, endpoint: "https://other.aiforce.cloud/openapi/lxe/catalog/sync", apiKey: "" })).toThrow("changing the destination");
    expect(() => parseTeamCatalogSettings({ ...settings, endpoint: "http://example.com/openapi/lxe/catalog/sync" })).toThrow("HTTPS");
    expect(() => parseTeamCatalogSettings({ ...settings, endpoint: "https://user:password@example.com/openapi/lxe/catalog/sync" })).toThrow("HTTPS");
    expect(() => new TeamCatalogSyncService(path, { ...secure, isEncryptionAvailable: () => false }, {} as DashboardTransport).state()).toThrow("Secure credential storage");
  });

  test("does not send invalid or duplicate catalog entries", async () => {
    let sent = false;
    const { service } = fixture(async () => { sent = true; return new Response(); }, () => [skill, skill]);
    service.save(settings); await expect(service.sync()).rejects.toThrow("Duplicate skill name"); expect(sent).toBe(false);
  });
});
