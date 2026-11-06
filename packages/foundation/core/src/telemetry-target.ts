/** A freshly observed device target; never an upload authentication credential. */
export type TelemetryTarget = { enabled: false } | {
  enabled: true;
  server_url: string;
  device: { kind: "managed_device" | "system_administrator"; id: string };
};

export function parseTelemetryTarget(value: unknown): TelemetryTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid telemetry target");
  const target = value as Record<string, unknown>;
  if (target.enabled === false && Object.keys(target).length === 1) return { enabled: false };
  const device = target.device as Record<string, unknown> | undefined;
  if (target.enabled !== true || typeof target.server_url !== "string" || !device
    || !["managed_device", "system_administrator"].includes(String(device.kind))
    || typeof device.id !== "string" || !device.id.trim()) throw new Error("Invalid telemetry target");
  const url = new URL(target.server_url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Invalid telemetry server URL");
  }
  return { enabled: true, server_url: url.origin, device: {kind: device.kind as "managed_device" | "system_administrator", id: device.id} };
}
