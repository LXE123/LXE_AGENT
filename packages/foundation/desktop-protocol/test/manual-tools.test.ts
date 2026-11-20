import { expect, test } from "bun:test";
import { parseManualToolCall, parseDashboardRpcCall } from "../src";
test("manual tool inputs validate bounded terminal writes, dimensions, browser visibility and commands", () => {
  const input = { sessionId: "s", id: "tool" };
  expect(parseDashboardRpcCall({ operation: "sessions.create", input: { workspace_id: "workspace" } })).toMatchObject({ operation: "sessions.create" });
  expect(() => parseManualToolCall({ operation: "terminal.create", input: { ...input, cols: 0, rows: 24 } })).toThrow("cols");
  expect(() => parseManualToolCall({ operation: "terminal.write", input: { ...input, data: "界".repeat(22000) } })).toThrow("65536");
  expect(() => parseManualToolCall({ operation: "browser.visible", input: { ...input, mountSrc: "test", visible: null } })).toThrow("visibility");
  expect(() => parseManualToolCall({ operation: "browser.command", input: { ...input, command: "executeJavaScript" } })).toThrow("command");
  expect(parseManualToolCall({ operation: "browser.visible", input: { ...input, mountSrc: "test", visible: false } }).operation).toBe("browser.visible");
  expect(() => parseManualToolCall({ operation: "terminal.get", input: { id: "x" } })).toThrow("sessionId");
});
