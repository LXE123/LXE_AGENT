// Use Chromium's image decoders for ICO, PNG and SVG. Only the small PNG goes into the saved tab.
export async function tabFavicon(data: string): Promise<string | undefined> {
  const image = new Image();
  image.src = data;
  try {
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d");
    if (!context || !image.naturalWidth || !image.naturalHeight) return;
    const scale = 32 / Math.max(image.naturalWidth, image.naturalHeight);
    const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    context.drawImage(image, (32 - width) / 2, (32 - height) / 2, width, height);
    return canvas.toDataURL("image/png");
  } catch { return undefined; }
}
