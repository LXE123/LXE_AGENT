import type { DesktopInputAssetSlot, DesktopSyntheticPerformerTask, LxeDesktopBridge } from "@lxe/desktop-protocol";

// Local example data, opt-in only. No files are read, written or revealed.
export function createWorkbenchDetailsFixture(calls: { operation: string; input?: unknown }[]) {
  let mode: "ready" | "empty" | "error" | "hold" = "ready";
  let revealError = false;
  let release: (() => void) | undefined;
  const version = (file_name: string, date = "2026-10-18") => ({ file_name, path: "/fixture/inputs/" + file_name, size_bytes: 482304, updated_at: date });
  const slots: DesktopInputAssetSlot[] = [
    { slot: "vietnam_full_workbook", display_name: "越南备货完整模板", used_by: ["越南备货"], current: version("越南备货清单.xlsx"), previous: null },
    { slot: "export_tax_master", display_name: "出口退税总表", used_by: ["采购汇总", "备货工作簿"], current: version("出口退税总表_2026-10.xlsx"), previous: version("出口退税总表_2026-09.xlsx", "2026-09-20") },
    { slot: "purchase_template", display_name: "采购订单模板", used_by: ["采购订单"], current: version("采购订单模板.xlsx"), previous: null },
    { slot: "shipping_template", display_name: "发货单模板", used_by: ["发货单"], current: version("shipment-template-for-international-orders-and-regional-warehouses-2026.xlsx"), previous: null },
    { slot: "product_catalog", display_name: "商品资料表", used_by: ["商品资料同步"], current: null, previous: null },
    { slot: "stock_parameters", display_name: "备货参数表", used_by: ["备货建议"], current: null, previous: null, current_error: "FileNotFoundError: /fixture/inputs/stock-parameters.xlsx" },
  ].map(slot => ({ ...slot, management: "command", manifest_revision: null, holds: "", directory: "/fixture/inputs/" + slot.slot }));
  return {
    controls: { mode(value: typeof mode) { mode = value; }, release() { mode = "ready"; release?.(); }, revealError(value: boolean) { revealError = value; } },
    desktop: {
      listInputAssets: async () => {
        calls.push({ operation: "assets.list" });
        if (mode === "hold") await new Promise<void>(resolve => { release = resolve; });
        if (mode === "error") throw new Error("PermissionError: fixture asset directory denied");
        return mode === "empty" ? [] : structuredClone(slots);
      },
      revealInputAssetSlot: async slot => {
        calls.push({ operation: "assets.reveal", input: slot });
        if (revealError) throw new Error("ENOENT: fixture asset folder missing");
      },
    } satisfies Partial<LxeDesktopBridge["desktop"]>,
  };
}

export function workbenchMediaTask(mode: "scan" | "running" | "apply"): DesktopSyntheticPerformerTask {
  const apply = mode === "apply";
  return { task_id: "task-handle", action: apply ? "apply" : "scan", state: mode === "running" ? "running" : "completed",
    stage: mode === "running" ? "scan" : "done", processed: mode === "running" ? 2 : apply ? 3 : 4, total: apply ? 3 : 4,
    current_file: "campaign/autumn-product-video.mp4", selection_id: "source-handle", recursive: false, error: "",
    counts: apply ? { tagged: 1, copied: 1, failed: 1 } : { needs_tag: 1, already_tagged: 1, unsupported: 1, failed: 1 },
    items: [
      { name: "cover.jpg", relative_path: "campaign/cover.jpg", media_type: "image", size_bytes: 482304, status: apply ? "tagged" : "needs_tag" },
      { name: "video.mp4", relative_path: "campaign/autumn-product-video.mp4", media_type: "video", size_bytes: 18253200, status: apply ? "copied" : "already_tagged" },
      ...(!apply ? [{ name: "sample.gif", relative_path: "campaign/sample.gif", media_type: "image" as const, size_bytes: 98042, status: "unsupported" as const }] : []),
      { name: "broken.png", relative_path: "campaign/broken.png", media_type: "image", size_bytes: 100, status: "failed", error: "ExifToolError: File format error — campaign/broken.png" },
    ],
  };
}
