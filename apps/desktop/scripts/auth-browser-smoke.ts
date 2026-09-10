// Runs real Electron pages against local fixtures, without any production login.
import { app } from "electron";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthBrowserHost } from "../src/main/auth-browser-host";
import { ElectronAuthBrowserSession, storageCookie } from "../src/main/auth-browser-session";

const state = mkdtempSync(join(tmpdir(), "lxe-auth-smoke-"));
app.setPath("userData", state);
app.commandLine.appendSwitch("host-resolver-rules", "MAP *.mabangerp.com 127.0.0.1");
app.commandLine.appendSwitch("no-proxy-server");
app.on("window-all-closed", () => {});

async function main(): Promise<void> {
  await app.whenReady();

  const host = new AuthBrowserHost(async headless => new ElectronAuthBrowserSession(headless, url => {
    try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname.endsWith(".mabangerp.com"); } catch { return false; }
  }));
  let status = 1;
  try {
    const cookie = storageCookie({ name: "fixture", value: "x", domain: "private.mabangerp.com", path: "/", session: true, sameSite: "no_restriction", secure: true, httpOnly: true });
    if (cookie.expires !== -1 || cookie.sameSite !== "None" || cookie.httpOnly !== true) throw new Error("Cookie normalization failed");
    await host.start();
    const [python, script] = process.argv.slice(2);
    if (!python || !script) throw new Error("Expected Python executable and fixture script");
    status = await new Promise<number>((resolve, reject) => {
      const child = spawn(python, [script], {
        stdio: "inherit",
        env: { ...process.env, ...host.environment(), LXE_DATA_ROOT: join(state, "data"), PYTHONUTF8: "1" },
      });
      child.once("error", reject);
      child.once("exit", code => resolve(code ?? 1));
    });
  } catch (error) {
    console.error(error);
  } finally {
    await host.stop();
    // Windows may retain Electron's userData locks until the process exits.
    // The fixture contains no real credentials; its caller can remove it later.
    try { rmSync(state, { recursive: true, force: true }); }
    catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    }
    app.exit(status);
  }
}
void main().catch(error => { console.error(error); app.exit(1); });
