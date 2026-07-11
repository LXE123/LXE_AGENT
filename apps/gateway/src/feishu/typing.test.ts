import { describe, expect, test } from "bun:test";
import type { JsonObject } from "@lxe/protocol";
import { FeishuTyping } from "./typing";

describe("Feishu typing reactions", () => {
  test("start is idempotent and stop removes then clears persisted state", async () => {
    const calls: string[] = [];
    const patches: JsonObject[] = [];
    const typing = new FeishuTyping({
      reactions: {
        add: async (messageId, emoji) => {
          calls.push(`add:${messageId}:${emoji}`);
          return "reaction-1";
        },
        remove: async (messageId, reactionId) => {
          calls.push(`remove:${messageId}:${reactionId}`);
        },
      },
      store: { patchResponseRoute: async (_id, update) => { patches.push(update as unknown as JsonObject); } },
    });
    const route = { response_route_id: "route-1", message_id: "om_source", extra_data: { source_message_id: "om_source" } };
    await typing.handle(route, "start");
    await typing.handle(route, "start");
    await typing.handle(route, "stop");
    expect(calls).toEqual(["add:om_source:Typing", "remove:om_source:reaction-1"]);
    expect(patches).toEqual([
      { patch: { typing_message_id: "om_source", typing_reaction_id: "reaction-1" } },
      { patch: { typing_message_id: "", typing_reaction_id: "" } },
    ]);
  });

  test("API failures are best effort and unsupported operations are rejected", async () => {
    const typing = new FeishuTyping({
      reactions: {
        add: async () => { throw new Error("SDK unavailable"); },
        remove: async () => { throw new Error("SDK unavailable"); },
      },
      store: { patchResponseRoute: async () => undefined },
    });
    await expect(typing.handle({ response_route_id: "route", message_id: "om", extra_data: {} }, "start")).resolves.toBeUndefined();
    await expect(typing.handle({ response_route_id: "route", message_id: "om", extra_data: {} }, "pulse")).rejects.toThrow("operation");
  });
});
