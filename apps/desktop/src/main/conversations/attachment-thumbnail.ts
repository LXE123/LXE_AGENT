import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { nativeImage } from "electron";
import { MAX_SCREENSHOT_BYTES, MAX_SCREENSHOT_PIXELS } from "../../conversation-paste";

/** Bound preview reads independently of the unrestricted local-file reference. */
export async function attachmentThumbnail(path: string, edge: number): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Only regular files can be previewed");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const current = await file.stat();
    if (!current.isFile()) throw new Error("Only regular files can be previewed");
    if (current.size > MAX_SCREENSHOT_BYTES) throw new Error("Image preview source exceeds 20 MiB");
    const buffer = Buffer.alloc(current.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > current.size) throw new Error("Image file grew while reading its preview");
    bytes = buffer.subarray(0, length);
  } finally { await file.close(); }
  return imageBytesThumbnail(bytes, edge, path);
}

/** Preview historical bytes using the same limits as file previews. */
export function imageBytesThumbnail(bytes: Uint8Array, edge: number, name = "historical image"): string {
  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) throw new Error("Image preview source exceeds 20 MiB");
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) throw new Error(`Electron could not decode image preview: ${name}`);
  const { width, height } = image.getSize();
  if (width * height > MAX_SCREENSHOT_PIXELS) throw new Error("Image preview exceeds 40000000 pixels");
  const scale = Math.min(1, edge / Math.max(width, height));
  return (scale < 1 ? image.resize({
    width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)),
  }) : image).toDataURL();
}
