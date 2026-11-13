import { expect, test } from "bun:test";
import { browserNavigationError, browserUrl } from "../src/main/browser-navigation";

test("web navigation accepts arbitrary HTTP(S) hosts and browser address input", () => {
  expect(browserUrl(" https://accounts.doubao.com/login ", "app://lxe/")).toBe("https://accounts.doubao.com/login");
  expect(browserUrl("http://localhost:8000/callback", "https://desktop.example/")).toBe("http://localhost:8000/callback");
  expect(browserUrl("example.com")).toBe("https://example.com/");
});

test("web navigation rejects special protocols, embedded credentials and the desktop origin", () => {
  for (const url of ["file:///private/file", "javascript:alert(1)", "about:blank", "lark://client", "https://user:secret@example.com/"]) {
    expect(() => browserUrl(url)).toThrow("HTTP or HTTPS without embedded credentials");
  }
  expect(() => browserUrl("http://localhost:5173/other", "http://localhost:5173/")).toThrow("application renderer");
  expect(() => browserUrl("app://lxe/")).toThrow("HTTP or HTTPS");
});

test("navigation failures retain the actual error without login URLs", () => {
  expect(browserNavigationError(new Error("ERR_FAILED (-2) loading 'https://login.example/callback?code=secret#token'")))
    .toBe("ERR_FAILED (-2) loading '[URL redacted]'");
});
