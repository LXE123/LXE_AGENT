import { describe, expect, test } from "bun:test";
import {
  DESKTOP_SUCCESS_NOTICE_MS,
  desktopSuccessNotice,
} from "../../src/desktop/notice-model";

describe("desktop notice model", () => {
  test("makes success dismissible for six seconds", () => {
    expect(desktopSuccessNotice(2, "完成")).toEqual({
      id: 2,
      message: "完成",
      dismissible: true,
      autoDismissMs: DESKTOP_SUCCESS_NOTICE_MS,
    });
    expect(DESKTOP_SUCCESS_NOTICE_MS).toBe(6_000);
  });
});
