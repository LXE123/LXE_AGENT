import { ipcMain, type BrowserWindow } from "electron";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { parseManualToolCall, type ManualToolEvent, type ManualToolCall } from "@lxe/desktop-protocol";
import { IPC_CHANNELS } from "../../ipc-channels";
import { ManualTerminals } from "./terminals";
import { ManualBrowsers } from "./browsers";
export class ManualToolsService {
  readonly terminals: ManualTerminals;
  readonly browsers: ManualBrowsers;
  private readonly creating = new Map<string, Promise<unknown>>();
  private updateFenced = false;
  activity(): string[] { return [...this.terminals.activity(), ...this.creating.keys()]; }
  beginUpdate(): () => void {
    this.updateFenced = true;
    return () => { this.updateFenced = false; };
  }
  async settleUpdateAdmissions(): Promise<void> { await Promise.allSettled(this.creating.values()); }
  constructor(private readonly window: () => BrowserWindow | undefined, root: string, private readonly resolveDirectory: (sessionId: string) => Promise<string | undefined>) {
    const emit = (event: ManualToolEvent) => { const window = this.window(); if (window && !window.isDestroyed()) window.webContents.send(IPC_CHANNELS.manualToolEvent, event); };
    this.terminals = new ManualTerminals(root, emit); this.browsers = new ManualBrowsers(window, emit);
  }
  register(): void {
    ipcMain.handle(IPC_CHANNELS.manualToolCall, (event, value) => {
      const window = this.window();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Manual tools are only available to the desktop renderer");
      return this.call(parseManualToolCall(value));
    });
  }
  private async directory(sessionId: string): Promise<string> {
    const directory = await this.resolveDirectory(sessionId); if (!directory) throw new Error(`Session workspace not found: ${sessionId}`);
    await access(directory, constants.R_OK | constants.X_OK); return directory;
  }
  async call(call: ManualToolCall): Promise<unknown> {
    if (this.updateFenced) throw new Error("Application update is preparing; manual tools are blocked");
    const { sessionId, id } = call.input;
    switch (call.operation) {
      case "terminal.create": case "browser.create": {
        const key = `${call.operation}:${id}`;
        let pending = this.creating.get(key);
        if (!pending) {
          pending = this.directory(sessionId).then<unknown>(directory => call.operation === "terminal.create"
            ? this.terminals.create(sessionId, id, directory, call.input.cols, call.input.rows)
            : this.browsers.create(sessionId, id, directory, call.input.url)).finally(() => this.creating.delete(key));
          this.creating.set(key, pending);
        }
        await pending;
        return call.operation === "terminal.create" ? this.terminals.get(sessionId, id) : this.browsers.get(sessionId, id);
      }
      case "terminal.get": await this.creating.get(`terminal.create:${id}`); return this.terminals.get(sessionId, id);
      case "terminal.write": return this.terminals.write(sessionId, id, call.input.data);
      case "terminal.resize": return this.terminals.resize(sessionId, id, call.input.cols, call.input.rows);
      case "terminal.close": await this.creating.get(`terminal.create:${id}`)?.catch(() => {}); return this.terminals.close(sessionId, id);
      case "browser.get": return this.browsers.get(sessionId, id);
      case "browser.navigate": return this.browsers.navigate(sessionId, id, call.input.url);
      case "browser.command": return this.browsers.command(sessionId, id, call.input.command);
      case "browser.present": return this.browsers.present(sessionId, id, call.input.bounds, call.input.clip);
      case "browser.close": await this.creating.get(`browser.create:${id}`)?.catch(() => {}); return this.browsers.close(sessionId, id);
    }
  }
  async closeSession(sessionId?: string): Promise<void> {
    await Promise.allSettled(this.creating.values());
    this.browsers.closeSession(sessionId); await this.terminals.closeSession(sessionId);
  }
  async stop(): Promise<void> { ipcMain.removeHandler(IPC_CHANNELS.manualToolCall); await this.closeSession(); }
}
