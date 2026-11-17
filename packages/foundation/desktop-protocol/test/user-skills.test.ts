import { expect, test } from "bun:test";
import { parseDashboardRpcCall, parseAgentCall, decodeAgentEvent, encodeAgentEvent, parseAgentWireValue, type DashboardRpcCall } from "../src";

test("user skill management uses Dashboard RPC and change notifications", () => {
  const id = "7bdb8807-249e-49e4-b4d6-5f50fd04a28b";
  const calls: DashboardRpcCall[] = [
    { operation: "skills.team.versions", input: { ids: [id] } },
    { operation: "skills.team.uninstallTarget", input: { id, version: "1.0.1" } },
    { operation: "skills.team.install", input: { ticket: { skillId: id, version: "1.0.0", sha256: "a".repeat(64), size: 100,
      expiresAt: new Date(Date.now() + 120_000).toISOString(), downloadUrl: "https://dataloom-rdqueaxi.feishucdn.com/4577945282/bucket_aadk3bkqatkfw/example?sign=fixture" } } },
    { operation: "skills.user.list", input: {} },
    { operation: "skills.user.content", input: { id: "entry", path: "assets/template.md" } },
    { operation: "skills.user.setEnabled", input: { id: "entry", version: "revision", enabled: false } },
    { operation: "skills.user.delete", input: { id: "entry", version: "revision" } },
  ];
  for (const call of calls) {
    expect(parseDashboardRpcCall(call)).toEqual(call);
    expect(parseAgentCall({ jsonrpc: "2.0", id: "skills", method: "dashboard_call", params: call })).toMatchObject({ params: call });
  }
  const event = { type: "skills.changed" as const, payload: { revision: 2 } };
  expect(decodeAgentEvent(encodeAgentEvent(event))).toEqual(event);
});

test("skill mutations require identity and version; invalid notifications are rejected", () => {
  for (const input of [
    {}, { id: "entry" }, { id: "entry", version: " " }, { path: "/tmp/skill", version: "v" },
    { id: "entry", version: "v", path: "/tmp/skill" },
  ]) expect(() => parseDashboardRpcCall({ operation: "skills.user.delete", input })).toThrow();
  expect(() => parseDashboardRpcCall({ operation: "skills.team.uninstallTarget", input: { id: "entry", version: "revision" } })).toThrow();
  expect(() => parseDashboardRpcCall({ operation: "skills.user.setEnabled", input: { id: "entry", version: "v", enabled: "false" } })).toThrow();
  for (const revision of [0, -1, 1.5, "2"]) {
    expect(() => parseAgentWireValue({ jsonrpc: "2.0", method: "skills.changed", params: { payload: { revision } } })).toThrow();
  }
});
