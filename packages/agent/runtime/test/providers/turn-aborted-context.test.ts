import { expect, test } from "bun:test";
import { repositoryRoot } from "@lxe/core";
import { turnAbortedMessage } from "../../src/engine/turn-aborted";
import { adaptMessagesForProvider, loadProviderDescriptor } from "../../src/providers/provider";
import { adaptMessagesForCompletions } from "../../src/providers/completions-provider";
import { adaptMessagesForResponses } from "../../src/providers/responses-provider";

test("all three adapters retain stop context separately from the next user input", () => {
  const marker = turnAbortedMessage();
  const next = "再提问一下，我看看新 UI";
  const messages = [marker, { role: "user" as const, content: next }];
  const descriptor = loadProviderDescriptor(repositoryRoot(import.meta.dir), {
    AGENT_LLM_PROVIDER: "kimi-coding", KIMI_CODE_API_KEY: "fixture-key",
  });
  const variants = [
    adaptMessagesForProvider(messages, descriptor),
    adaptMessagesForCompletions(messages),
    adaptMessagesForResponses(messages),
  ];
  for (const adapted of variants) {
    expect(adapted).toHaveLength(2);
    expect(adapted.map(m => m.role)).toEqual(["user", "user"]);
    expect(JSON.stringify(adapted[0])).toContain("<turn_aborted>");
    expect(JSON.stringify(adapted[0])).not.toContain(next);
    expect(JSON.stringify(adapted[1])).toContain(next);
    expect(JSON.stringify(adapted[1])).not.toContain("turn_aborted");
  }
});
