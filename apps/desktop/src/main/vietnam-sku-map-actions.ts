import type {
  DesktopInputAssetSlot,
  DesktopVietnamSkuMapMutation,
} from "@lxe/desktop-protocol";

const SKU_SLOT = "vietnam_sku_parameter_map";

export interface VietnamSkuMapActionsDependencies {
  list(): Promise<DesktopInputAssetSlot[]>;
  choose(): Promise<{ canceled: boolean; filePaths: string[] }>;
  install(sourcePath: string, expectedRevision: string | null): Promise<DesktopVietnamSkuMapMutation>;
  rollback(expectedRevision: string): Promise<DesktopVietnamSkuMapMutation>;
}

/** Coordinates a native file choice without accepting paths from the renderer. */
export function createVietnamSkuMapActions(dependencies: VietnamSkuMapActionsDependencies) {
  return {
    async upload(): Promise<DesktopVietnamSkuMapMutation | null> {
      const target = (await dependencies.list()).find(item => item.slot === SKU_SLOT);
      if (!target || target.management !== "desktop") {
        throw new Error("越南 SKU 参数表管理槽位不可用");
      }
      if (target.manifest_error) throw new Error(target.manifest_error);
      const expectedRevision = target.manifest_revision;
      const selection = await dependencies.choose();
      if (selection.canceled || !selection.filePaths[0]) return null;
      return dependencies.install(selection.filePaths[0], expectedRevision);
    },
    rollback(expectedRevision: string): Promise<DesktopVietnamSkuMapMutation> {
      return dependencies.rollback(expectedRevision);
    },
  };
}
