import { execFileSync } from "node:child_process";
import { clipboard } from "electron";

// Electron 43 exposes file-list formats but DOM paste may omit files or return only one.
const MAC_FILE_PATHS = `ObjC.import('AppKit');
function run() {
  var urls=$.NSPasteboard.generalPasteboard.readObjectsForClassesOptions(
    $([$.NSURL]), $({NSPasteboardURLReadingFileURLsOnlyKey:true}));
  var paths=[];
  for(var i=0;i<urls.count;i++) paths.push(urls.objectAtIndex(i).path.js);
  return JSON.stringify(paths);
}`;
const WINDOWS_FILE_PATHS = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
ConvertTo-Json -InputObject @([System.Windows.Forms.Clipboard]::GetFileDropList()) -Compress`;

/** Read native file references only, on an explicit composer paste gesture. */
export function readClipboardFilePaths(): string[] {
  if (!clipboard.availableFormats().includes("text/uri-list")) return [];
  const options = { encoding: "utf8" as const, timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 };
  const output = process.platform === "darwin"
    ? execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_FILE_PATHS], options)
    : process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_FILE_PATHS], options)
      : "[]";
  const paths: unknown = JSON.parse(output.replace(/^\uFEFF/u, ""));
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path)) throw new Error("Native clipboard returned invalid file paths");
  return paths;
}
