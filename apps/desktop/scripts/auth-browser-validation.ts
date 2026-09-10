// Explicit developer harness for real-browser validation with the packaged runtime.
// Credentials are loaded by the child on the test machine, never logged here.
import { app } from "electron";
import { spawn } from "node:child_process";
import { AuthBrowserHost } from "../src/main/auth-browser-host";
import { ElectronAuthBrowserSession } from "../src/main/auth-browser-session";

const userData = process.env.LXE_AUTH_VALIDATION_USER_DATA;
if (!userData) throw new Error("LXE_AUTH_VALIDATION_USER_DATA is required for an isolated validation run");
app.setPath("userData", userData);
app.on("window-all-closed", () => {});

async function main(): Promise<void> {
  await app.whenReady();
  const host = new AuthBrowserHost(async headless => new ElectronAuthBrowserSession(headless));
  let status = 1;
  try {
    await host.start();
    const python = process.env.LXE_AUTH_VALIDATION_PYTHON;
    const script = process.env.LXE_AUTH_VALIDATION_SCRIPT;
    if (!python || !script) throw new Error("Validation Python and script paths are required");
    console.log(JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome }));
    status = await new Promise<number>((resolve, reject) => {
      const child = spawn(python, [script], { stdio: "inherit", env: { ...process.env, ...host.environment(), PYTHONUTF8: "1" } });
      child.once("error", reject);
      child.once("exit", code => resolve(code ?? 1));
    });
  } catch (error) { console.error(error); }
  finally { await host.stop(); app.exit(status); }
}
void main().catch(error => { console.error(error); app.exit(1); });
