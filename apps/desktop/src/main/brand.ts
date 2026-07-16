import type { DesktopPlatform } from "@lxe/desktop-protocol";
import { nativeImage } from "electron";

const bodyPath = "M30 4C14 4 4 16 4 32c0 14 9 25 23 29l4-11c-9-2-15-9-15-18 0-9 7-16 16-16 7 0 13 5 15 12l11-4C54 12 43 4 30 4ZM26 60c0-12 3-21 10-27l-1-11 9 7c7 0 11 4 12 9l6 3-6 4c-1 8-7 13-15 15H26Z";
const acornPath = "M45 45c1-3 4-5 8-5s7 2 8 5H45Zm2 2h12c0 5-3 9-6 11-3-2-6-6-6-11Z";

export const trayIconSvg = (platform: DesktopPlatform): string => {
  const template = platform === "darwin";
  const body = template ? "#000000" : "#b46a4d";
  const detail = template ? "#000000" : "#faf8f5";
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 64 64">',
    `<path d="${bodyPath}" fill="${body}"/>`,
    `<circle cx="48" cy="35" r="1.8" fill="${detail}"/>`,
    `<path d="${acornPath}" fill="${detail}"/>`,
    `<path d="M38 43c3 0 6 2 8 5" fill="none" stroke="${body}" stroke-width="3.5" stroke-linecap="round"/>`,
    "</svg>",
  ].join("");
};

const svgDataUrl = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

export const createTrayIcon = (platform: DesktopPlatform): Electron.NativeImage => {
  const image = nativeImage.createFromDataURL(svgDataUrl(trayIconSvg(platform)));
  if (platform === "darwin") image.setTemplateImage(true);
  return image;
};
