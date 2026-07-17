import type { DesktopComponentState, DesktopHealth } from "@lxe/desktop-protocol";

import type {
  ChannelHealthList,
  ChannelHealthPayload,
} from "../../api/payloads";

export type HomeChannelState =
  | "connected"
  | "connecting"
  | "error"
  | "disabled"
  | "unconfigured"
  | "unavailable";

const CONNECTING_CHANNEL_STATES = new Set(["starting", "reconnecting", "connecting"]);

export function aggregateAgentState(health: Pick<DesktopHealth, "agent_cli" | "lxeskill">): DesktopComponentState {
  const states = [health.agent_cli, health.lxeskill];
  if (states.includes("error")) return "error";
  if (states.includes("stopped")) return "stopped";
  if (states.includes("starting")) return "starting";
  return "ready";
}

function channelItemState(health: ChannelHealthPayload): HomeChannelState {
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
): HomeChannelState {
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
