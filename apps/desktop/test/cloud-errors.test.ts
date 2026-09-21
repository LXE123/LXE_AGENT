import { expect, test } from "bun:test";
import { cloudErrorMessage, parseCloudError } from "../src/main/cloud-errors";

const body = (user_message: unknown, code: unknown = "future_error", message = "technical diagnostic") => JSON.stringify({ detail: { code, user_message, message } });

test("custom text overrides known and unknown codes, including missing code", () => {
  expect(parseCloudError(JSON.stringify({ detail: { user_message: "No code hint" } })).userMessage).toBe("No code hint");
  for (const code of ["future_error", "device_permission_contract_incompatible", undefined]) {
    expect(cloudErrorMessage(parseCloudError(body("New user hint", code)), 409, "fallback")).toBe("New user hint");
  }
});
test.each([undefined, null, 0, [], {}, "", "  ", "\u0000\u202e"].map(value => [value]))("invalid user text falls back (%j)", value => {
  expect(parseCloudError(body(value)).userMessage).toBeUndefined();
  expect(cloudErrorMessage(parseCloudError(body(value)), 409, "fallback")).toBe("fallback");
});
test("legacy objects, strings, validation arrays and non-JSON retain fallbacks", () => {
  for (const raw of ["proxy failure", "<html>Gateway failure</html>", "null", "[]", JSON.stringify({ detail: "legacy" }), JSON.stringify({ detail: [] })]) {
    expect(cloudErrorMessage(parseCloudError(raw), 503, "offline")).toBe("offline");
  }
  expect(cloudErrorMessage(parseCloudError(body(null, "device_permission_contract_incompatible")), 409, "fallback")).toContain("升级");
});
test("JSON is parsed before diagnostic truncation and Unicode truncation preserves code points", () => {
  const raw = JSON.stringify({ detail: { message: "x".repeat(900), user_message: "😀".repeat(310), code: "future_error" } });
  const parsed = parseCloudError(raw);
  expect(parsed.code).toBe("future_error");
  expect(parsed.userMessage).toEndWith("… [truncated]");
  expect(Array.from(parsed.userMessage!).length).toBe(300);
  expect(parsed.userMessage).not.toMatch(/[\ud800-\udfff]/u);
  expect(Array.from(parsed.diagnostic).length).toBe(500);
  expect(parsed.diagnostic).toEndWith("… [truncated]");
});
test("pure text keeps HTML inert, strips controls and redacts known and recognizable credentials", () => {
  const token = "lxe_client_fixture." + "s".repeat(43);
  const parsed = parseCloudError(body(`<img src=x onerror=alert(1)>\u0000\u202e ${token} custom-secret http://cloud.local`), ["custom-secret", "http://cloud.local"]);
  expect(parsed.userMessage).toStartWith("<img src=x onerror=alert(1)>");
  expect(parsed.userMessage).not.toContain(token);
  expect(parsed.userMessage).not.toContain("custom-secret");
  expect(parsed.userMessage).not.toContain("http://cloud.local");
  expect(parsed.userMessage).not.toContain("\u202e");
  expect(parsed.diagnostic).not.toContain(token);
  expect(parsed.diagnostic).not.toContain("custom-secret");
  expect(parseCloudError(body("hint", { attacker: true })).code).toBeUndefined();
});
