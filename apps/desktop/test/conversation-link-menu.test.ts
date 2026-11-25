import { expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { conversationLinkMenuTemplate, validateConversationLinkMenu, type ConversationMenuCommand } from "../src/main/conversation-link-menu";

const web = { kind: "web", language: "en", url: "https://example.com/path?q=1", x: 14, y: 28, copyMessage: true, fork: true } as const;
const ref = { kind: "linked", path: "../files/guide.md", session_id: "s" } as const;
function fixture() {
  const calls: unknown[] = [];
  const native = { platform: "darwin" as const, copy: (text: string) => { calls.push(text); }, openUrl: async (url: string) => { calls.push(url); } };
  let selected: ConversationMenuCommand | undefined;
  const fileLinkMenu = async () => ({
    filename: "guide.md", relativePath: "../files/guide.md", absolutePath: "/files/guide.md", lookupError: undefined,
    authorize: () => calls.push("grant"), applications: [{ name: "Editor", id: "editor", default: true, icon: null }],
  });
  const files = { fileLinkMenu, fileCall: (async (call: unknown) => { calls.push(call); }) as Parameters<typeof conversationLinkMenuTemplate>[1]["fileCall"] };
  async function click(item: MenuItemConstructorOptions) {
    selected = undefined;
    item.click!({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    if (!selected) throw new Error("No native menu selection");
    return (selected as ConversationMenuCommand)();
  }
  return { calls, files, native, click, select: (action: ConversationMenuCommand) => { selected = action; } };
}

test("web menu separates link actions from available message actions", async () => {
  const f = fixture();
  const items = await conversationLinkMenuTemplate(web, f.files, f.native, f.select);
  expect(items.map(i => i.label ?? i.type)).toEqual(["Open in system browser", "Open in browser pane", "Copy link", "separator", "Copy message", "Fork from here"]);
  expect(await Promise.all(items.filter(i => i.click).map(i => f.click(i)))).toEqual([null, "sidebar", null, "copy-message", "fork"]);
  expect(f.calls).toEqual([web.url, web.url]);
  const unavailable = await conversationLinkMenuTemplate({ ...web, copyMessage: false, fork: false }, f.files, f.native, f.select);
  expect(unavailable).toHaveLength(3);
  for (const url of ["file:///tmp/test", "javascript:alert(1)", "https://name:password@example.com"]) {
    expect(() => validateConversationLinkMenu({ ...web, url })).toThrow();
  }
});

test("file menu copies text without granting access and opens only the chosen file", async () => {
  const f = fixture();
  const menu = await conversationLinkMenuTemplate({ kind: "file", ref, x: 1, y: 1, language: "zh" }, f.files, f.native, f.select);
  expect(menu.map(i => i.label)).toEqual(["在右侧预览", "复制", "打开方式", "在 Finder 中显示"]);
  for (const item of menu[1]!.submenu as MenuItemConstructorOptions[]) await f.click(item);
  expect(f.calls).toEqual(["../files/guide.md", "/files/guide.md", "guide.md"]);
  expect(await f.click(menu[0]!)).toBe("preview");
  await f.click((menu[2]!.submenu as MenuItemConstructorOptions[])[0]!);
  await f.click(menu[3]!);
  expect(f.calls.slice(3)).toEqual(["grant", "grant", { operation: "open", input: { ref, application: "editor" } }, "grant", { operation: "open", input: { ref, reveal: true } }]);
  expect(() => validateConversationLinkMenu({ ...web, kind: "file", ref: { ...ref, kind: "attachment" } })).toThrow();
});

test("selected text actions precede the clicked message or link actions", async () => {
  const f = fixture();
  const message = { kind: "message", language: "zh", x: 2, y: 3, copyMessage: true, fork: true } as const;
  const menu = (input: unknown) => conversationLinkMenuTemplate(validateConversationLinkMenu(input), f.files, f.native, f.select);
  expect((await menu(message)).map(i => i.label)).toEqual(["复制消息", "从这里分支"]);
  for (const source of [message, { ...web, language: "zh" }, { ...message, kind: "file", ref }]) {
    const selected = await menu({ ...source, selection: "copy-and-quote" });
    expect(selected.slice(0, 3).map(i => i.label ?? i.type)).toEqual(["复制选中文字", "引用到输入框", "separator"]);
    expect(await f.click(selected[0]!)).toBe("copy-selection");
    expect(await f.click(selected[1]!)).toBe("quote-selection");
  }
  const copyOnly = await menu({ ...message, fork: false, selection: "copy" });
  expect(copyOnly[1]?.enabled).toBe(false);
  expect(copyOnly.at(-1)?.label).toBe("复制消息");
  expect(() => validateConversationLinkMenu({ ...message, selection: "other" })).toThrow();
});
