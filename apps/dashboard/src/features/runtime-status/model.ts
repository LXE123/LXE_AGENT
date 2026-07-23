import type {
  DesktopCloudConnectionState,
  DesktopComponentState,
  DesktopHealth,
} from "@lxe/desktop-protocol";

import type {
  ChannelHealthList,
  ChannelHealthPayload,
} from "../../api/payloads";

export type RuntimeChannelState =
  | "connected"
  | "connecting"
  | "error"
  | "disabled"
  | "unconfigured"
  | "unavailable";

export type RuntimeTone = "healthy" | "progress" | "warning" | "neutral";

const CONNECTING_CHANNEL_STATES = new Set(["starting", "reconnecting", "connecting"]);

export function aggregateAgentState(
  health: Pick<DesktopHealth, "agent_cli" | "lxeskill">,
): DesktopComponentState {
  const states = [health.agent_cli, health.lxeskill];
  if (states.includes("error")) return "error";
  if (states.includes("stopped")) return "stopped";
  if (states.includes("starting")) return "starting";
  return "ready";
}

export function componentTone(state: DesktopComponentState): RuntimeTone {
  if (state === "ready") return "healthy";
  if (state === "starting") return "progress";
  if (state === "error" || state === "stopped") return "warning";
  return "neutral";
}

export function channelTone(state: RuntimeChannelState): RuntimeTone {
  if (state === "connected") return "healthy";
  if (state === "connecting") return "progress";
  if (state === "error") return "warning";
  return "neutral";
}

export function cloudTone(state: DesktopCloudConnectionState): RuntimeTone {
  if (state === "connected") return "healthy";
  if (state === "connecting" || state === "provisioning") return "progress";
  if (state === "offline" || state === "error") return "warning";
  return "neutral";
}

export function cloudAggregateTone(state: DesktopCloudConnectionState): RuntimeTone | undefined {
  if (state === "not_configured" || state === "unsupported") return undefined;
  return cloudTone(state);
}

export function aggregateRuntimeTone(tones: RuntimeTone[]): RuntimeTone {
  if (tones.includes("warning")) return "warning";
  if (tones.includes("progress")) return "progress";
  if (tones.length > 0 && tones.every((tone) => tone === "healthy")) return "healthy";
  return "neutral";
}

function channelItemState(health: ChannelHealthPayload): RuntimeChannelState {
  const connectionState = String(health.connection_state || "").trim().toLowerCase();
  if (health.ready === true || connectionState === "connected") return "connected";
  if (health.restart_in_progress || CONNECTING_CHANNEL_STATES.has(connectionState)) return "connecting";
  if (health.running === false) return "disabled";
  if (health.last_error || health.ready === false || health.running === true) return "error";
  return "unavailable";
}

export function summarizeChannelState(
  channels: ChannelHealthList | undefined,
  unavailable = false,
): RuntimeChannelState {
  if (!channels) return unavailable ? "unavailable" : "unconfigured";
  const items = Object.values(channels.items || {});
  if (!items.length) return "unconfigured";
  const states = items.map(channelItemState);
  if (states.includes("error")) return "error";
  if (states.includes("connecting")) return "connecting";
  if (states.includes("connected")) return "connected";
  if (states.every((state) => state === "disabled")) return "disabled";
  return "unavailable";
}
