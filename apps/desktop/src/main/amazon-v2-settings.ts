import type { DesktopAmazonV2Settings } from "@lxe/desktop-protocol";
import { LxeSkillError, redactAndBound, settingsPayload, type LxeSkillClient } from "./lxeskill-client";

export function isAmazonV2Settings(input: unknown): input is DesktopAmazonV2Settings {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2) return false;
  const value = input as Record<string, unknown>;
  return typeof value.peak_boost_enabled === "boolean" && (value.peak_boost_days === null
    || (typeof value.peak_boost_days === "number" && Number.isInteger(value.peak_boost_days)
      && value.peak_boost_days >= 0 && value.peak_boost_days <= 120))
    && (!value.peak_boost_enabled || value.peak_boost_days !== null);
}

/** Desktop consumes the lxeskill contract; Python owns validation and storage. */
export class DesktopAmazonV2SettingsService {
  constructor(private readonly lxeskill: LxeSkillClient) {}

  private async call(action: "read" | "save", value?: string): Promise<DesktopAmazonV2Settings> {
    const args = ["replenish", "v2", "settings", "--action", action];
    if (value !== undefined) args.push("--parameters", value);
    const result = await this.lxeskill.run(args, { timeoutMs: 30_000 });
    const settings = settingsPayload(result);
    if (!isAmazonV2Settings(settings)) {
      throw new LxeSkillError(redactAndBound(`Invalid lxeskill settings result: ${JSON.stringify(result.record)}`));
    }
    return settings;
  }

  read(): Promise<DesktopAmazonV2Settings> { return this.call("read"); }
  save(input: unknown): Promise<DesktopAmazonV2Settings> {
    if (!isAmazonV2Settings(input)) {
      throw new Error("peak_boost_enabled must be a boolean; peak_boost_days must be an integer between 0 and 120 when enabled, otherwise null is allowed");
    }
    const serialized = JSON.stringify(input);
    return this.call("save", serialized);
  }
}
