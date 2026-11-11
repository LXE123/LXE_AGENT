/** Desktop-owned, user-operated tools. These calls are never exposed to model tools. */
export interface TerminalSnapshot { id: string; sessionId: string; shell: string; output: string; sequence: number; exited: boolean; exitCode?: number; error?: string }
export interface BrowserSnapshot { id: string; sessionId: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error: string }
export interface BrowserClip { x: number; y: number; width: number; height: number; radius: number }
export interface ManualToolOperations {
  "terminal.create": { input: { sessionId: string; id: string; cols: number; rows: number }; result: TerminalSnapshot };
  "terminal.get": { input: { sessionId: string; id: string }; result: TerminalSnapshot | null };
  "terminal.write": { input: { sessionId: string; id: string; data: string }; result: void };
  "terminal.resize": { input: { sessionId: string; id: string; cols: number; rows: number }; result: void };
  "terminal.close": { input: { sessionId: string; id: string }; result: void };
  "browser.create": { input: { sessionId: string; id: string; url?: string }; result: BrowserSnapshot };
  "browser.get": { input: { sessionId: string; id: string }; result: BrowserSnapshot | null };
  "browser.navigate": { input: { sessionId: string; id: string; url: string }; result: void };
  "browser.command": { input: { sessionId: string; id: string; command: "back" | "forward" | "reload" }; result: void };
  "browser.present": { input: { sessionId: string; id: string; bounds: { x: number; y: number; width: number; height: number } | null; clip?: BrowserClip }; result: void };
  "browser.close": { input: { sessionId: string; id: string }; result: void };
}
export type ManualToolOperation = keyof ManualToolOperations;
export type ManualToolCall<K extends ManualToolOperation = ManualToolOperation> = { [P in K]: { operation: P; input: ManualToolOperations[P]["input"] } }[K];
export type ManualToolEvent =
  | { kind: "terminal.output"; sessionId: string; id: string; sequence: number; data: string }
  | { kind: "terminal.state"; snapshot: TerminalSnapshot }
  | { kind: "browser.state"; snapshot: BrowserSnapshot }
  | { kind: "browser.open"; sessionId: string; url: string };
export interface ManualToolsBridge {
  call<K extends ManualToolOperation>(call: ManualToolCall<K>): Promise<ManualToolOperations[K]["result"]>;
  subscribe(listener: (event: ManualToolEvent) => void): () => void;
}
const operations = new Set(["terminal.create", "terminal.get", "terminal.write", "terminal.resize", "terminal.close", "browser.create", "browser.get", "browser.navigate", "browser.command", "browser.present", "browser.close"]);
export function parseManualToolCall(value: unknown): ManualToolCall {
  if (!value || typeof value !== "object") throw new Error("Invalid manual tool request");
  const { operation, input } = value as { operation: string; input: Record<string, unknown> };
  if (!operations.has(operation) || !input || typeof input !== "object") throw new Error("Unknown manual tool operation");
  for (const key of ["sessionId", "id"]) if (typeof input[key] !== "string" || !input[key] || input[key].length > 200) throw new Error(`Invalid ${key}`);
  if (operation === "terminal.create" || operation === "terminal.resize") {
    for (const [key, max] of [["cols", 500], ["rows", 200]] as const) if (!Number.isInteger(input[key]) || Number(input[key]) < 2 || Number(input[key]) > max) throw new Error(`Invalid terminal ${key}`);
  }
  if (operation === "terminal.write" && (typeof input.data !== "string" || new TextEncoder().encode(input.data).length > 65536)) throw new Error("Terminal input exceeds 65536 bytes or is invalid");
  if ((operation === "browser.navigate" || operation === "browser.create" && input.url !== undefined) && (typeof input.url !== "string" || input.url.length > 8192)) throw new Error("Invalid browser URL");
  if (operation === "browser.command" && !["back", "forward", "reload"].includes(String(input.command))) throw new Error("Invalid browser command");
  if (operation === "browser.present" && input.bounds !== null) {
    const b = input.bounds as Record<string, unknown> | undefined;
    if (!b || ["x", "y", "width", "height"].some(key => typeof b[key] !== "number" || !Number.isFinite(b[key]) || Math.abs(Number(b[key])) > 100000) || Number(b.width) < 0 || Number(b.height) < 0) throw new Error("Invalid browser bounds");
  }
  if (operation === "browser.present" && input.clip !== undefined) {
    const clip = input.clip as Record<string, unknown> | null;
    if (!clip || ["x", "y", "width", "height", "radius"].some(key => typeof clip[key] !== "number" || !Number.isFinite(clip[key]) || Math.abs(Number(clip[key])) > 100000)
      || Number(clip.width) < 0 || Number(clip.height) < 0 || Number(clip.radius) < 0) throw new Error("Invalid browser clip");
  }
  return value as ManualToolCall;
}
