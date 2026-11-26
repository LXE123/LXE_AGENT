import { mkdirSync } from "node:fs";
import type {
  DesktopInputAssetSlot,
  DesktopInputAssetVersion,
} from "@lxe/desktop-protocol";
import { redactAndBound, type LxeSkillClient } from "./lxeskill-client";

const LIST_TIMEOUT_MS = 30_000;
const REVISION = /^[0-9a-f]{32}$/u;

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

const versionValue = (value: unknown): DesktopInputAssetVersion | null => {
  const item = objectValue(value);
  if (!item) return null;
  const fileName = String(item.file_name ?? "").trim();
  const path = String(item.path ?? "").trim();
  if (!fileName || !path) return null;
  const size = Number(item.size_bytes);
  return {
    file_name: fileName,
    path,
    size_bytes: Number.isFinite(size) && size >= 0 ? size : 0,
    updated_at: String(item.updated_at ?? ""),
  };
};

const slotValue = (value: unknown): DesktopInputAssetSlot | null => {
  const item = objectValue(value);
  if (!item) return null;
  const slot = String(item.slot ?? "").trim();
  const displayName = String(item.display_name ?? "").trim();
  const usedBy = Array.isArray(item.used_by)
    ? item.used_by.map(usage => String(usage).trim()).filter(Boolean)
    : [];
  const directory = String(item.directory ?? "").trim();
  if (!slot || !displayName || usedBy.length === 0 || !directory) return null;
  if (item.management !== "desktop" && item.management !== "command") {
    throw new Error(`Input asset ${slot} has invalid management: ${String(item.management)}`);
  }
  const revision = item.manifest_revision ?? null;
  if (revision !== null && (typeof revision !== "string" || !REVISION.test(revision))) {
    throw new Error(`Input asset ${slot} has invalid manifest revision`);
  }
  const field = (name: "current_error" | "previous_error" | "manifest_error") => {
    const value = item[name];
    return typeof value === "string" && value.trim() ? { [name]: redactAndBound(value) } : {};
  };
  return {
    slot,
    management: item.management,
    manifest_revision: revision,
    ...field("current_error"),
    ...field("previous_error"),
    ...field("manifest_error"),
    display_name: displayName,
    used_by: usedBy,
    holds: String(item.holds ?? ""),
    directory,
    current: versionValue(item.current),
    previous: versionValue(item.previous),
  };
};

/** The Python asset registry and managed slot store remain the only source of truth. */
export class DesktopInputAssetsService {
  constructor(private readonly lxeskill: LxeSkillClient) {}

  async list(): Promise<DesktopInputAssetSlot[]> {
    const { data } = await this.lxeskill.run(["assets", "list"], { timeoutMs: LIST_TIMEOUT_MS });
    if (!Array.isArray(data.slots)) throw new Error("lxeskill assets list returned no slots");
    return data.slots.map(slotValue).filter((slot): slot is DesktopInputAssetSlot => slot !== null);
  }

  async directoryFor(slot: string): Promise<string> {
    const match = (await this.list()).find(item => item.slot === slot);
    if (!match) throw new Error(`Unknown input asset slot: ${slot}`);
    mkdirSync(match.directory, { recursive: true });
    return match.directory;
  }
}
