import type { JsonObject, JsonValue } from "@lxe/protocol";
import type { DirectGatewayStorage } from "./direct-composition";
import type { ResponseRoutePatch, ResponseRouteRecord } from "./models";

interface RuntimeGatewayStorageBackend {
  ensureSession(request: JsonObject): Promise<void>;
  rebindSession(request: JsonObject): Promise<void>;
  upsertResponseRoute(request: JsonObject): Promise<void>;
  getSession(sessionId: string): Promise<{ session_id: string; source: JsonObject } | undefined>;
  popPendingEvents(sessionId: string): Promise<JsonObject[]>;
  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void>;
  hasPendingEvents(sessionId: string): Promise<boolean>;
  getResponseRoute(responseRouteId: string): Promise<JsonObject | undefined>;
  patchResponseRoute(responseRouteId: string, update: JsonObject): Promise<void>;
}

const text = (value: JsonValue | undefined): string => String(value ?? "").trim();
const nullableText = (value: JsonValue | undefined): string | null =>
  value === null || value === undefined ? null : text(value);
const object = (value: JsonValue | undefined): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

export class DirectGatewayStorageAdapter implements DirectGatewayStorage {
  constructor(private readonly backend: RuntimeGatewayStorageBackend) {}

  ensureSession(request: JsonObject): Promise<void> { return this.backend.ensureSession(request); }
  rebindSession(request: JsonObject): Promise<void> { return this.backend.rebindSession(request); }
  upsertResponseRoute(request: JsonObject): Promise<void> { return this.backend.upsertResponseRoute(request); }
  getSession(sessionId: string): Promise<{ session_id: string; source: JsonObject } | undefined> {
    return this.backend.getSession(sessionId);
  }
  popPendingEvents(sessionId: string): Promise<JsonObject[]> { return this.backend.popPendingEvents(sessionId); }
  appendPendingEvent(sessionId: string, event: JsonObject): Promise<void> {
    return this.backend.appendPendingEvent(sessionId, event);
  }
  hasPendingEvents(sessionId: string): Promise<boolean> { return this.backend.hasPendingEvents(sessionId); }

  async getResponseRoute(responseRouteId: string): Promise<ResponseRouteRecord | undefined> {
    const route = await this.backend.getResponseRoute(responseRouteId);
    if (!route) return undefined;
    return {
      response_route_id: text(route.response_route_id),
      owner_user_id: text(route.owner_user_id),
      platform: text(route.platform),
      platform_message_id: nullableText(route.platform_message_id),
      conversation_id: nullableText(route.conversation_id),
      conversation_type: nullableText(route.conversation_type),
      sender_nick: nullableText(route.sender_nick),
      extra_data: object(route.extra_data),
      created_at: nullableText(route.created_at),
      updated_at: nullableText(route.updated_at),
    };
  }

  patchResponseRoute(responseRouteId: string, update: ResponseRoutePatch): Promise<void> {
    const translated: JsonObject = {};
    if (update.patch !== undefined) translated.extra_data = update.patch;
    if (update.deliveryHandle?.platform_message_id !== undefined) {
      translated.platform_message_id = update.deliveryHandle.platform_message_id;
    }
    return this.backend.patchResponseRoute(responseRouteId, translated);
  }
}
