import type { DesktopVietnamSettingsState, DesktopVietnamTemplateExportResult } from "@lxe/desktop-protocol";
import { settingsPayload, type LxeSkillClient } from "./lxeskill-client";

/** Desktop consumes the lxeskill contract; Python owns validation and storage. */
export class DesktopVietnamSettingsService {
  constructor(private readonly lxeskill: LxeSkillClient) {}

  private async call<T = DesktopVietnamSettingsState>(action: "read" | "save" | "upload" | "export", ...values: string[]): Promise<T> {
    const result = await this.lxeskill.run(["vietnam", "replenishment", "settings", "--action", action, ...values],
      { timeoutMs: 180_000 });
    return settingsPayload(result) as T;
  }

  read(): Promise<DesktopVietnamSettingsState> { return this.call("read"); }
  save(input: unknown): Promise<DesktopVietnamSettingsState> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("越南备货参数必须是对象");
    const serialized = JSON.stringify(input);
    if (serialized.length > 4096) throw new Error("越南备货参数过长");
    return this.call("save", "--parameters", serialized);
  }
  uploadTemplate(path: string): Promise<DesktopVietnamSettingsState> { return this.call("upload", "--path", path); }
  exportTemplate(path: string): Promise<DesktopVietnamTemplateExportResult> {
    return this.call<DesktopVietnamTemplateExportResult>("export", "--path", path);
  }
}
