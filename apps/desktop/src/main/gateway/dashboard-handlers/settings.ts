import { createLogger } from "@lxe/core";
import { DESKTOP_MCP_NAME, type AgentDashboardRpcCall, type CredentialSource } from "@lxe/desktop-protocol";
import { publicDashboardChannelHealth } from "../dashboard-channel-health";
import type { DashboardHandler, DashboardHandlers } from "./context";

interface RuntimeModelChoice {
  provider: string;
  model: string;
  credential_source: CredentialSource;
  thinking_state: { level: string };
}

/** agentcli applies the model choice; Desktop then remembers it as the default unless told not to. */
function rememberModelChoice<O extends "models.update" | "models.thinking.update">(): DashboardHandler<O> {
  return async (call, { runtime, config }) => {
    const result = await runtime.dashboardCall(call as AgentDashboardRpcCall<O>);
    if (call.input.remember_default !== false) {
      const model = result as unknown as RuntimeModelChoice;
      try {
        config.saveRuntimePreference(model.provider, model.model, model.thinking_state.level, model.credential_source);
      } catch (error) {
        if (!call.input.session_id) throw error;
        // The runtime has committed the conversation choice; a default-save failure cannot undo it.
        createLogger("desktop.models").warn("default_model_save_failed", { session_id: call.input.session_id, error: String(error) });
      }
    }
    return result;
  };
}

export const settingsHandlers: DashboardHandlers = {
  "mcp.servers.update": async (call, { runtime, automations }) => {
    if (call.input.name !== DESKTOP_MCP_NAME) return runtime.dashboardCall(call);
    if (!automations) throw new Error("Desktop automations are unavailable");
    return automations.setMcpEnabled(call.input.enabled);
  },

  "channels.health": async (_call, { parts }) => {
    const items = publicDashboardChannelHealth(await parts.channels.healthSnapshot());
    return { items, total: Object.keys(items).length };
  },

  "models.update": rememberModelChoice<"models.update">(),
  "models.thinking.update": rememberModelChoice<"models.thinking.update">(),
};
