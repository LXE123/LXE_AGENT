import type { ConversationLinkMenuRequest, ConversationLinkMenuAction } from "@lxe/desktop-protocol";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopGateway } from "./desktop-gateway";
import type { FileApplicationLookup } from "./file-preview/service";
import { validateRef } from "./file-preview/paths";
import { isExternallyOpenableUrl } from "./launch-mode";

export function validateConversationLinkMenu(value: unknown): ConversationLinkMenuRequest {
  const input = value as Partial<ConversationLinkMenuRequest> | null;
  if (!input || (input.language !== "zh" && input.language !== "en") ||
    !Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error("Invalid conversation link menu");
  const { selection } = input;
  if (selection !== undefined && selection !== "copy" && selection !== "copy-and-quote") throw new Error("Invalid conversation selection");
  const base = { language: input.language, x: input.x!, y: input.y!, ...(selection && { selection }) };
  if ((input.kind === "web" || input.kind === "message") && typeof input.copyMessage === "boolean" && typeof input.fork === "boolean") {
    const actions = { ...base, copyMessage: input.copyMessage, fork: input.fork };
    if (input.kind === "message" && (input.copyMessage || input.fork || selection)) return { ...actions, kind: "message" };
    if (input.kind === "web" && typeof input.url === "string" && isExternallyOpenableUrl(input.url)) return { ...actions, kind: "web", url: input.url };
  }
  if (input.kind === "file") {
    const ref = validateRef(input.ref);
    if (ref.kind === "linked" || ref.kind === "workspace") return { ...base, kind: "file", ref };
  }
  throw new Error("Invalid conversation link target");
}

export type ConversationMenuCommand = () => ConversationLinkMenuAction | Promise<ConversationLinkMenuAction>;
type MenuSelect = (command: ConversationMenuCommand) => void;
export const APPLICATION_MENU_WAIT_MS = 300;

async function settledWithin<T>(value: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: Parameters<typeof clearTimeout>[0];
  try {
    return await Promise.race([value, new Promise<undefined>(resolve => { timer = setTimeout(resolve, milliseconds); })]);
  } finally { clearTimeout(timer); }
}

export async function conversationLinkMenuTemplate(
  request: ConversationLinkMenuRequest, files: Pick<DesktopGateway, "fileLinkMenu" | "fileCall">,
  native: {
    copy(text: string): void; openUrl(url: string): Promise<void>; platform: NodeJS.Platform;
    /** Pops a follow-up menu at the original point and runs the chosen command. */
    popup(build: (select: MenuSelect) => MenuItemConstructorOptions[]): Promise<ConversationLinkMenuAction>;
    applicationWaitMs?: number;
  },
  select: MenuSelect,
): Promise<MenuItemConstructorOptions[]> {
  const label = (zh: string, en: string) => request.language === "zh" ? zh : en;
  const item = (label: string, command: ConversationMenuCommand): MenuItemConstructorOptions => ({ label, click: () => select(command) });
  const copy = (text: string): ConversationLinkMenuAction => { native.copy(text); return null; };
  const items: MenuItemConstructorOptions[] = [];
  if (request.selection) {
    items.push(item(label("复制选中文字", "Copy selected text"), () => "copy-selection"),
      { ...item(label("引用到输入框", "Quote in composer"), () => "quote-selection"), enabled: request.selection === "copy-and-quote" });
  }
  if (request.kind !== "file") {
    if (request.kind === "web") {
      if (items.length) items.push({ type: "separator" });
      items.push(
        item(label("在系统浏览器打开", "Open in system browser"), async () => { await native.openUrl(request.url); return null; }),
        item(label("在右侧浏览器打开", "Open in browser pane"), () => "sidebar"),
        item(label("复制链接", "Copy link"), () => copy(request.url)),
      );
    }
    if (items.length && (request.copyMessage || request.fork)) items.push({ type: "separator" });
    if (request.copyMessage) items.push(item(label("复制消息", "Copy message"), () => "copy-message"));
    if (request.fork) items.push(item(label("从这里分支", "Fork from here"), () => "fork"));
    return items;
  }

  const ref = request.ref;
  const file = await files.fileLinkMenu(ref);
  const open = async (options: { application?: string; reveal?: boolean }) => {
    file.authorize();
    await files.fileCall({ operation: "open", input: { ref, ...options } });
    return null;
  };
  const applicationItems = (lookup: FileApplicationLookup, choose: typeof item) => {
    const apps = lookup.applications.map(app => choose(app.name, () => open({ application: app.id })));
    if (!apps.length) apps.push({ label: lookup.error || label("没有可用应用", "No applications available"), enabled: false });
    return apps;
  };
  // Show the menu promptly; a slow handler lookup moves to a follow-up menu at the same point.
  const ready = await settledWithin(file.applications, native.applicationWaitMs ?? APPLICATION_MENU_WAIT_MS);
  const apps = ready ? applicationItems(ready, item) : [
    item(label("用默认应用打开", "Open with default application"), () => open({})),
    item(label("选择其他应用…", "Choose another application…"), async () => {
      const lookup = await file.applications;
      return native.popup(choose => applicationItems(lookup, (name, command) => ({ label: name, click: () => choose(command) })));
    }),
  ];
  const reveal = native.platform === "darwin" ? label("在 Finder 中显示", "Show in Finder")
    : native.platform === "win32" ? label("在文件资源管理器中显示", "Show in File Explorer") : label("在文件管理器中显示", "Show in file manager");
  return [
    ...items, ...(items.length ? [{ type: "separator" as const }] : []),
    item(label("在右侧预览", "Preview in sidebar"), () => { file.authorize(); return "preview"; }),
    { label: label("复制", "Copy"), submenu: [
      { ...item(label("相对路径", "Relative path"), () => file.relativePath ? copy(file.relativePath) : null), enabled: !!file.relativePath },
      item(label("绝对路径", "Absolute path"), () => copy(file.absolutePath)),
      item(label("文件名", "Filename"), () => copy(file.filename)),
    ] },
    { label: label("打开方式", "Open with"), submenu: apps },
    item(reveal, () => open({ reveal: true })),
  ];
}
