import { expect, test } from "bun:test";
import { parseManualToolCall, parseDashboardRpcCall } from "../src";
test("manual tool inputs validate bounded terminal writes, dimensions, browser geometry and commands", () => {
  const input = { sessionId: "s", id: "tool" };
  expect(parseDashboardRpcCall({ operation: "sessions.create", input: { workspace_id: "workspace" } })).toMatchObject({ operation: "sessions.create" });
  expect(() => parseManualToolCall({ operation: "terminal.create", input: { ...input, cols: 0, rows: 24 } })).toThrow("cols");
  expect(() => parseManualToolCall({ operation: "terminal.write", input: { ...input, data: "界".repeat(22000) } })).toThrow("65536");
  expect(() => parseManualToolCall({ operation: "browser.present", input: { ...input, bounds: { x: 0, y: 0, width: NaN, height: 50 } } })).toThrow("bounds");
  expect(() => parseManualToolCall({ operation: "browser.command", input: { ...input, command: "executeJavaScript" } })).toThrow("command");
  expect(parseManualToolCall({ operation: "browser.present", input: { ...input, bounds: null } }).operation).toBe("browser.present");
  expect(() => parseManualToolCall({ operation: "terminal.get", input: { id: "x" } })).toThrow("sessionId");
});
