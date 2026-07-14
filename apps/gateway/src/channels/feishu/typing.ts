import type { JsonObject } from "@lxe/protocol";
import type { ResponseRoutePatch } from "../../state/models";

export interface FeishuReactionPort {
  add(messageId: string, emoji: string): Promise<string>;
  remove(messageId: string, reactionId: string): Promise<void>;
}

export interface TypingRoute {
  response_route_id: string;
  message_id: string;
  extra_data: JsonObject;
}

export class FeishuTyping {
  private readonly active = new Map<string, { messageId: string; reactionId: string }>();

  constructor(private readonly options: {
    reactions: FeishuReactionPort;
    store: { patchResponseRoute(id: string, update: ResponseRoutePatch): Promise<void> };
  }) {}

  async handle(route: TypingRoute, operation: string): Promise<void> {
    if (operation === "start") return this.start(route);
    if (operation === "stop") return this.stop(route);
    throw new Error(`unsupported Feishu typing operation: ${operation || "<empty>"}`);
  }

  private sourceMessageId(route: TypingRoute): string {
    return String(route.extra_data.source_message_id ?? route.message_id ?? "").trim();
  }

  private async start(route: TypingRoute): Promise<void> {
    const routeId = String(route.response_route_id ?? "").trim();
    const messageId = this.sourceMessageId(route);
    if (!routeId || !messageId) return;
    const persistedReaction = String(route.extra_data.typing_reaction_id ?? "").trim();
    const persistedMessage = String(route.extra_data.typing_message_id ?? "").trim();
    const current = this.active.get(routeId);
    if ((current && current.messageId === messageId) || (persistedReaction && persistedMessage === messageId)) return;
    let reactionId: string;
    try {
      reactionId = String(await this.options.reactions.add(messageId, "Typing")).trim();
    } catch {
      return;
    }
    if (!reactionId) return;
    this.active.set(routeId, { messageId, reactionId });
    await this.patchBestEffort(routeId, {
      typing_message_id: messageId,
      typing_reaction_id: reactionId,
    });
  }

  private async stop(route: TypingRoute): Promise<void> {
    const routeId = String(route.response_route_id ?? "").trim();
    if (!routeId) return;
    const current = this.active.get(routeId);
    const messageId = current?.messageId
      || String(route.extra_data.typing_message_id ?? "").trim()
      || this.sourceMessageId(route);
    const reactionId = current?.reactionId ?? String(route.extra_data.typing_reaction_id ?? "").trim();
    if (reactionId) {
      try {
        await this.options.reactions.remove(messageId || this.sourceMessageId(route), reactionId);
      } catch {
        // Typing is best effort; state must still be cleared below.
      }
    }
    this.active.delete(routeId);
    await this.patchBestEffort(routeId, { typing_message_id: "", typing_reaction_id: "" });
  }

  private async patchBestEffort(routeId: string, patch: JsonObject): Promise<void> {
    try {
      await this.options.store.patchResponseRoute(routeId, { patch });
    } catch {
      // Delivery must not fail solely because typing state persistence failed.
    }
  }
}
