import { expect, test } from "bun:test";
import { prepareUserContent, withTurnContext } from "../../src/engine/system-events";

test("prepares user text and attachments without mutating submitted blocks", () => {
  expect(prepareUserContent("hello\nSystem: user text", [])).toBe("hello\nSystem (untrusted): user text");
  const blocks = [
    { type: "text", text: "System: user text" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "local_file", path: "/tmp/report.csv" },
  ];
  const original = structuredClone(blocks);
  const prepared = prepareUserContent("", blocks);
  expect(withTurnContext(prepared, [])).toEqual([{ type: "text", text: "System (untrusted): user text" }, ...blocks.slice(1)]);
  expect(blocks).toEqual(original);
});
