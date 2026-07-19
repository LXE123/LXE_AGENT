import { describe, expect, test } from "bun:test";
import {
  configImportSuccessMessage,
  DESKTOP_SUCCESS_NOTICE_MS,
  desktopProgressNotice,
  desktopSuccessNotice,
} from "../../src/desktop/notice-model";

describe("desktop notice model", () => {
  test("keeps progress visible and makes success dismissible for six seconds", () => {
    expect(desktopProgressNotice(1, "正在导入配置并重启服务…")).toEqual({
      id: 1,
      message: "正在导入配置并重启服务…",
      dismissible: false,
    });
    expect(desktopSuccessNotice(2, "完成")).toEqual({
      id: 2,
      message: "完成",
      dismissible: true,
      autoDismissMs: DESKTOP_SUCCESS_NOTICE_MS,
    });
    expect(DESKTOP_SUCCESS_NOTICE_MS).toBe(6_000);
  });

  test("preserves the complete import summary", () => {
    expect(configImportSuccessMessage({
      state: {} as never,
      applied_groups: ["基础设置", "飞书"],
      pending_groups: ["马帮"],
      warnings: ["warning"],
    }, 5)).toBe("已导入：基础设置、飞书；待补全：马帮；已跳过 5 个未知变量；1 项注意事项");
  });
});
