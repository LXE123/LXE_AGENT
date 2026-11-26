import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuInboundNormalizer, snapshotMessageEvent } from "../../../src/channels/feishu/inbound";
import {
  FEISHU_OWNER_REPLIES,
  FEISHU_PAIRING_TTL_MS,
  FeishuOwnerAccess,
  FeishuOwnerFile,
} from "../../../src/channels/feishu/owner";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ownerPath = (): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-feishu-owner-"));
  roots.push(root);
  return join(root, "db", "feishu-owner.json");
};

const snapshot = (patch: { text?: string; open_id?: string; chat_type?: string; message_type?: string; content?: string; mentions?: unknown[] } = {}) =>
  snapshotMessageEvent({
    header: { app_id: "cli_test" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: patch.open_id ?? "ou_owner_0001" } },
      message: {
        message_type: patch.message_type ?? "text",
        content: patch.content ?? JSON.stringify({ text: patch.text ?? "hello" }),
        chat_type: patch.chat_type ?? "p2p",
        chat_id: "oc_chat",
        create_time: "1000000",
        message_id: `om_${Math.random()}`,
        mentions: patch.mentions ?? [],
      },
    },
  })!;

const access = (path: string, clock: { now: number }, appId = "cli_test") => new FeishuOwnerAccess({
  file: new FeishuOwnerFile(path),
  appId,
  now: () => clock.now,
  code: () => "482915",
});

describe("Feishu owner access", () => {
  test("refuses everyone until the owner pairs, then admits only the owner", () => {
    const path = ownerPath();
    const clock = { now: 1_000 };
    const owner = access(path, clock);

    expect(owner.decide(snapshot())).toEqual({ allowed: false, reason: "owner_unpaired", reply: FEISHU_OWNER_REPLIES.unpaired });
    expect(owner.startPairing()).toEqual({ code: "482915", expires_at: new Date(1_000 + FEISHU_PAIRING_TTL_MS).toISOString() });
    expect(owner.status().pairing?.code).toBe("482915");

    expect(owner.decide(snapshot({ text: " 482915 " }))).toEqual({
      allowed: false, reason: "pairing_completed", reply: FEISHU_OWNER_REPLIES.paired,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      app_id: "cli_test", open_id: "ou_owner_0001", paired_at: new Date(1_000).toISOString(),
    });
    expect(owner.status()).toEqual({
      paired: true, owner_open_id_masked: "ou_ow…001", paired_at: new Date(1_000).toISOString(), pairing: null,
    });

    expect(owner.decide(snapshot({ text: "482915" }))).toEqual({ allowed: true });
    expect(owner.decide(snapshot({ chat_type: "group" }))).toEqual({ allowed: true });
    expect(owner.decide(snapshot({ open_id: "ou_colleague" }))).toEqual({
      allowed: false, reason: "not_owner", reply: FEISHU_OWNER_REPLIES.notOwner,
    });
  });

  test("pairs only from a private chat with a live code", () => {
    const path = ownerPath();
    const clock = { now: 1_000 };
    const owner = access(path, clock);
    owner.startPairing();

    expect(owner.decide(snapshot({ text: "482915", chat_type: "group", open_id: "ou_colleague" })).allowed).toBe(false);
    expect(owner.decide(snapshot({ text: "000000" }))).toMatchObject({ reason: "owner_unpaired" });
    expect(owner.status().paired).toBe(false);

    clock.now += FEISHU_PAIRING_TTL_MS;
    expect(owner.decide(snapshot({ text: "482915" }))).toMatchObject({ reason: "owner_unpaired" });
    expect(owner.status()).toMatchObject({ paired: false, pairing: null });
  });

  test("re-pairing moves ownership while the old owner keeps access until the code is used", () => {
    const path = ownerPath();
    const clock = { now: 1_000 };
    const owner = access(path, clock);
    owner.startPairing();
    owner.decide(snapshot({ text: "482915" }));

    owner.startPairing();
    expect(owner.decide(snapshot())).toEqual({ allowed: true });
    expect(owner.decide(snapshot({ text: "482915", open_id: "ou_new_phone" }))).toMatchObject({ reason: "pairing_completed" });
    expect(owner.decide(snapshot())).toMatchObject({ reason: "not_owner" });
    expect(owner.decide(snapshot({ open_id: "ou_new_phone" }))).toEqual({ allowed: true });
  });

  test("an owner paired under another Feishu app no longer counts", () => {
    const path = ownerPath();
    const clock = { now: 1_000 };
    const owner = access(path, clock);
    owner.startPairing();
    owner.decide(snapshot({ text: "482915" }));

    const otherApp = access(path, clock, "cli_other");
    expect(otherApp.status().paired).toBe(false);
    expect(otherApp.decide(snapshot())).toMatchObject({ reason: "owner_unpaired" });
  });

  test("reports a corrupt owner file instead of treating it as unpaired", () => {
    const path = ownerPath();
    const owner = access(path, { now: 1_000 });
    owner.startPairing();
    owner.decide(snapshot({ text: "482915" }));
    writeFileSync(path, "{broken", "utf8");
    expect(() => owner.decide(snapshot())).toThrow("invalid Feishu owner file");
  });
});

describe("Feishu owner check in inbound normalization", () => {
  test("refuses before converting content, so refused senders cost no Feishu API calls", async () => {
    const path = ownerPath();
    const owner = access(path, { now: 1_000_000 });
    let fetched = 0;
    const normalizer = new FeishuInboundNormalizer({
      botOpenId: "ou_bot",
      appId: "cli_test",
      nowMs: () => 1_000_000,
      access: (value) => owner.decide(value),
      converterContext: {
        fetchSubMessages: async () => { fetched += 1; return []; },
        resolveUserName: (id) => id,
      },
    });

    const decision = await normalizer.normalize(snapshot({
      open_id: "ou_colleague",
      chat_type: "group",
      message_type: "merge_forward",
      content: "{}",
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "LXE" }],
    }));
    expect(decision).toMatchObject({ accepted: false, reason: "owner_unpaired", reply: FEISHU_OWNER_REPLIES.unpaired });
    expect(fetched).toBe(0);

    const ignoredGroupMessage = await normalizer.normalize(snapshot({ chat_type: "group", open_id: "ou_colleague" }));
    expect(ignoredGroupMessage).toMatchObject({ accepted: false, reason: "group_without_bot_mention" });
    expect(ignoredGroupMessage).not.toHaveProperty("reply");
  });
});
