import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRuntimeStore } from "@lxe/runtime";
import { DirectGatewayStorageAdapter } from "./storage-adapter";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DirectGatewayStorageAdapter", () => {
  test("translates Gateway route patches into the Runtime SQLite contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-gateway-storage-"));
    roots.push(root);
    const backend = new SqliteRuntimeStore(join(root, "local_agent.sqlite3"));
    await backend.start();
    await backend.upsertResponseRoute({
      response_route_id: "route-1",
      platform: "feishu",
      user_id: "ou-user",
      conversation_id: "oc-chat",
      source: { message_id: "om-source" },
    });
    const storage = new DirectGatewayStorageAdapter(backend);

    await storage.patchResponseRoute("route-1", {
      patch: { cardkit_card_id: "card-1", cardkit_emit_id: "emit-1" },
    });
    await storage.patchResponseRoute("route-1", {
      deliveryHandle: { platform: "feishu", platform_message_id: "om-card" },
    });

    expect(await storage.getResponseRoute("route-1")).toEqual(expect.objectContaining({
      response_route_id: "route-1",
      platform: "feishu",
      platform_message_id: "om-card",
      extra_data: expect.objectContaining({
        source_message_id: "om-source",
        cardkit_card_id: "card-1",
        cardkit_emit_id: "emit-1",
      }),
    }));
    await backend.stop();
  });
});
