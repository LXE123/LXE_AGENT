export const MAX_CONVERSATION_FILES = 5;
export const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;
export const MAX_SCREENSHOT_PIXELS = 40_000_000;

/** File bytes are permitted only for clipboard images without a local path. */
export type ConversationPasteInput = {
  paths: string[];
  images: Uint8Array[];
};

export async function prepareConversationPaste(
  files: readonly File[],
  getPath: (file: File) => string,
): Promise<ConversationPasteInput> {
  const paths = [...new Set(files.map(getPath).filter(Boolean))];
  if (paths.length) {
    if (paths.length > MAX_CONVERSATION_FILES) throw new Error("You can attach at most 5 files per turn");
    return { paths, images: [] };
  }
  if (files.length > MAX_CONVERSATION_FILES) throw new Error("You can attach at most 5 files per turn");
  for (const file of files) {
    if (!file.type.startsWith("image/")) throw new Error("Pasted file has no local path and is not an image");
    if (file.size === 0 || file.size > MAX_SCREENSHOT_BYTES) throw new Error("Screenshot must contain between 1 byte and 20 MiB");
  }
  const images: Uint8Array[] = [];
  for (const file of files) images.push(new Uint8Array(await file.arrayBuffer()));
  return { paths: [], images };
}
