import type { ConversationLinkMenuRequest, ConversationLinkMenuAction } from "@lxe/desktop-protocol";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopGateway } from "./desktop-gateway";
import { validateRef } from "./file-preview/paths";
import { isExternallyOpenableUrl } from "./launch-mode";

export function validateConversationLinkMenu(value: unknown): ConversationLinkMenuRequest {
  const input = value as Partial<ConversationLinkMenuRequest> | null;
  if (!input || (input.language !== "zh" && input.language !== "en") ||
    !Number.isFinite(input.x) || !Number.isFinite(input.y)) throw new Error("Invalid conversation link menu");
  const base = { language: input.language, x: input.x!, y: input.y! };
  if (input.kind === "web" && typeof input.url === "string" && isExternallyOpenableUrl(input.url)
    && typeof input.copyMessage === "boolean" && typeof input.fork === "boolean") {
    return { ...base, kind: "web", url: input.url, copyMessage: input.copyMessage, fork: input.fork };
  }
  if (input.kind === "file") {
    const ref = validateRef(input.ref);
    if (ref.kind === "linked" || ref.kind === "workspace") return { ...base, kind: "file", ref };
  }
  throw new Error("Invalid conversation link target");
}

export type ConversationMenuCommand = () => ConversationLinkMenuAction | Promise<ConversationLinkMenuAction>;
export async function conversationLinkMenuTemplate(
  request: ConversationLinkMenuRequest, files: Pick<DesktopGateway, "fileLinkMenu" | "fileCall">,
  native: { copy(text: string): void; openUrl(url: string): Promise<void>; platform: NodeJS.Platform },
  select: (command: ConversationMenuCommand) => void,
): Promise<MenuItemConstructorOptions[]> {
  const label = (zh: string, en: string) => request.language === "zh" ? zh : en;
  const item = (label: string, command: ConversationMenuCommand): MenuItemConstructorOptions => ({ label, click: () => select(command) });
  const copy = (text: string): ConversationLinkMenuAction => { native.copy(text); return null; };
  if (request.kind === "web") {
    const items: MenuItemConstructorOptions[] = [
      item(label("在系统浏览器打开", "Open in system browser"), async () => { await native.openUrl(request.url); return null; }),
      item(label("在右侧浏览器打开", "Open in browser pane"), () => "sidebar"),
      item(label("复制链接", "Copy link"), () => copy(request.url)),
    ];
    if (request.copyMessage || request.fork) items.push({ type: "separator" });
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
  const apps = file.applications.map(app => item(app.name, () => open({ application: app.id })));
  if (!apps.length) apps.push({ label: file.lookupError || label("没有可用应用", "No applications available"), enabled: false });
  const reveal = native.platform === "darwin" ? label("在 Finder 中显示", "Show in Finder")
    : native.platform === "win32" ? label("在文件资源管理器中显示", "Show in File Explorer") : label("在文件管理器中显示", "Show in file manager");
  return [
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
