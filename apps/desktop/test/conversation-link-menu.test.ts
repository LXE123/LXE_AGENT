import { expect, test } from "bun:test";
import type { MenuItemConstructorOptions } from "electron";
import { conversationLinkMenuTemplate, validateConversationLinkMenu, type ConversationMenuCommand } from "../src/main/conversation-link-menu";
import type { FileApplicationLookup } from "../src/main/file-preview/service";

const web = { kind: "web", language: "en", url: "https://example.com/path?q=1", x: 14, y: 28, copyMessage: true, fork: true } as const;
const ref = { kind: "linked", path: "../files/guide.md", session_id: "s" } as const;
const editor = { name: "Editor", id: "editor", default: true, icon: null };
function fixture(applications: Promise<FileApplicationLookup> = Promise.resolve({ applications: [editor] })) {
  const calls: unknown[] = [];
  const followUps: string[][] = [];
  let selected: ConversationMenuCommand | undefined;
  const native = {
    platform: "darwin" as const, applicationWaitMs: 20,
    copy: (text: string) => { calls.push(text); }, openUrl: async (url: string) => { calls.push(url); },
    // Picks the first enabled follow-up item, as a user would after the second popup appears.
    popup: async (build: (select: (command: ConversationMenuCommand) => void) => MenuItemConstructorOptions[]) => {
      let chosen: ConversationMenuCommand | undefined;
      const items = build(command => { chosen = command; });
      followUps.push(items.map(i => String(i.label)));
      items.find(i => i.enabled !== false)?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
      return chosen ? chosen() : null;
    },
  };
  const fileLinkMenu = async () => ({
    filename: "guide.md", relativePath: "../files/guide.md", absolutePath: "/files/guide.md",
    authorize: () => calls.push("grant"), applications,
  });
  const files = { fileLinkMenu, fileCall: (async (call: unknown) => { calls.push(call); }) as Parameters<typeof conversationLinkMenuTemplate>[1]["fileCall"] };
  async function click(item: MenuItemConstructorOptions) {
    selected = undefined;
    item.click!({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
    if (!selected) throw new Error("No native menu selection");
    return (selected as ConversationMenuCommand)();
  }
  return { calls, followUps, files, native, click, select: (action: ConversationMenuCommand) => { selected = action; } };
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

test("a slow application lookup does not hold back the file menu", async () => {
  let finish!: (lookup: FileApplicationLookup) => void;
  const f = fixture(new Promise(resolve => { finish = resolve; }));
  const started = Date.now();
  const menu = await conversationLinkMenuTemplate({ kind: "file", ref, x: 1, y: 1, language: "en" }, f.files, f.native, f.select);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(menu.map(i => i.label)).toEqual(["Preview in sidebar", "Copy", "Open with", "Show in Finder"]);
  const openWith = menu[2]!.submenu as MenuItemConstructorOptions[];
  expect(openWith.map(i => i.label)).toEqual(["Open with default application", "Choose another application…"]);
  await f.click(openWith[0]!);
  expect(f.calls).toEqual(["grant", { operation: "open", input: { ref } }]);

  // The follow-up menu waits for the lookup, then opens the chosen application.
  const chosen = f.click(openWith[1]!);
  expect(f.followUps).toEqual([]);
  finish({ applications: [editor] });
  expect(await chosen).toBeNull();
  expect(f.followUps).toEqual([["Editor"]]);
  expect(f.calls.slice(2)).toEqual(["grant", { operation: "open", input: { ref, application: "editor" } }]);

  // A failed lookup shows its actual error instead of an empty menu.
  const failed = fixture(new Promise(resolve => setTimeout(() => resolve({ applications: [], error: "lookup failed: EACCES" }), 60)));
  const failedMenu = await conversationLinkMenuTemplate({ kind: "file", ref, x: 1, y: 1, language: "en" }, failed.files, failed.native, failed.select);
  expect(await failed.click((failedMenu[2]!.submenu as MenuItemConstructorOptions[])[1]!)).toBeNull();
  expect(failed.followUps).toEqual([["lookup failed: EACCES"]]);
  expect(failed.calls).toEqual([]);
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
