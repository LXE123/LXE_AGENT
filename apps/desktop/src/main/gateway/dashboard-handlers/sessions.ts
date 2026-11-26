import { createLogger } from "@lxe/core";
import { DashboardRpcError, type AgentDashboardRpcCall } from "@lxe/desktop-protocol";
import { LocalConversationSessionNotFoundError } from "@lxe/gateway/desktop";
import { prepareConversationAttachments } from "../../conversations/conversation-submission";
import { runSessionDeletion } from "../session-deletion";
import type { DashboardHandlers } from "./context";

export const sessionHandlers: DashboardHandlers = {
  "sessions.fork": async (call, { parts, runtime }) => {
    const activity = parts.conversations.activity(call.input.session_id);
    if (call.input.turn_id ? activity.active?.turn_id === call.input.turn_id :
      parts.scheduler.hasInflightWork(call.input.session_id) || activity.active || activity.queued.length) {
      throw new DashboardRpcError("failed_precondition", "Wait for the current turn to finish");
    }
    return runtime.dashboardCall(call);
  },

  "sessions.delete": async (call, context) => {
    const { parts, runtime } = context;
    await parts.sessionStatus?.flush();
    const sessionId = call.input.session_id;
    const sessionKeys = Object.values(parts.bindings.loadAll())
      .filter((entry) => entry.session_id === sessionId)
      .map((entry) => entry.session_key);
    const releaseFence = parts.scheduler.beginSessionDeletion(sessionId, sessionKeys);
    if (!releaseFence) {
      throw new DashboardRpcError(
        "failed_precondition",
        "session has an active or queued turn; stop it before deleting",
      );
    }
    try {
      return await runSessionDeletion({
        detach: async onUndo => {
          await context.beforeDeleteSession?.(sessionId);
          context.store?.pastedText?.prepareDeletion(sessionId, await runtime.sessionAttachmentPaths(sessionId));
          const gatewaySnapshot = context.store?.detachSession(sessionId);
          onUndo(() => context.store?.restoreSession(gatewaySnapshot));
          const removedBindings = parts.bindings.removeSession(sessionId);
          onUndo(() => parts.bindings.restore(removedBindings));
        },
        deleteAgentSession: () => runtime.dashboardCall(call as AgentDashboardRpcCall<"sessions.delete">),
        // A bound automation that stays active after a failed pause pauses itself at its next
        // run, when it finds the target session missing.
        cleanup: [
          ["session_delete_automation_pause_failed",
            () => context.automations?.service.pauseSession(sessionId, "绑定的会话已删除，请修改任务")],
          ["session_delete_conversation_forget_failed", () => parts.conversations.forgetSession(sessionId)],
          ["session_delete_runtime_state_forget_failed", () => parts.runtimeState.forget(sessionId)],
        ],
        afterCommit: () => context.collectPastedText(sessionId),
        logFailure: (event, error) =>
          createLogger("desktop.sessions").error(event, { session_id: sessionId, error: String(error) }),
      });
    } finally {
      releaseFence();
    }
  },

  "sessions.send": async (call, context) => {
    const attachmentIds = call.input.attachment_ids ?? [];
    let held = false;
    let rollbackAdmission: (() => void) | undefined;
    try {
      const result = await context.parts.conversations.send({
        ...(call.input.directory === undefined ? {} : { directory: call.input.directory }),
        ...(call.input.session_id ? { session_id: call.input.session_id } : {}),
        text: call.input.text,
        ...(call.input.steer_turn_id ? { steer_turn_id: call.input.steer_turn_id } : {}),
        ...(call.input.client_message_id ? { client_message_id: call.input.client_message_id } : {}),
        attachments: () => {
          if (!attachmentIds.length) return [];
          const staged = context.attachments.beginSend(attachmentIds);
          held = true;
          return prepareConversationAttachments(staged,
            (bytes, mediaType) => context.prepareImage(bytes, mediaType));
        },
        beforeAttachmentAdmission: (sessionId, files) => {
          rollbackAdmission = context.store?.pastedText?.admit(sessionId, files.map(file => file.path));
        },
      });
      rollbackAdmission = undefined;
      if (held) context.attachments.consume(attachmentIds);
      return result;
    } catch (error) {
      rollbackAdmission?.();
      if (error instanceof LocalConversationSessionNotFoundError) {
        throw new DashboardRpcError("not_found", error.message);
      }
      throw error;
    } finally {
      if (held) context.attachments.finishSend(attachmentIds);
    }
  },

  "sessions.stop": async (call, { parts }) => parts.conversations.stop(call.input.session_id, call.input.turn_id),

  "sessions.activity": async (call, { parts }) => parts.conversations.activity(call.input.session_id),

  "sessions.status.list": async (call, { parts }) => {
    if (!parts.sessionStatus) throw new Error("Session status service is unavailable");
    return parts.sessionStatus.list(call.input.session_ids);
  },

  "sessions.status.ack": async (call, { parts }) => {
    if (!parts.sessionStatus) throw new Error("Session status service is unavailable");
    return parts.sessionStatus.ack(call.input.session_id, call.input.turn_id, call.input.version);
  },
};
