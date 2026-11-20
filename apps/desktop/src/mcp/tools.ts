import { AUTOMATION_DEFINITION_SCHEMA } from "@lxe/desktop-protocol";

export const desktopTools = [
  { name: "automation_list", description: "List desktop scheduled tasks and available workspaces. Use for explicit user requests to schedule work, check back, or manage scheduled tasks. Only the desktop app runs these tasks; it must remain running.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false } },
  { name: "automation_update", description: "Create, view, update, pause, resume, or delete a desktop scheduled task when requested by the user. New mode starts a fresh chat each run; reuse mode continues an existing chat (session_id=current binds this chat). View first to obtain the current version before editing. Do not duplicate a task after an uncertain response; query the list first.",
    inputSchema: { type: "object" as const, required: ["mode"], additionalProperties: false, properties: {
      mode: { enum: ["create", "view", "update", "pause", "resume", "delete"] }, id: { type: "string" }, version: { type: "integer", minimum: 1 }, definition: AUTOMATION_DEFINITION_SCHEMA,
    } } },
  { name: "automation_run_now", description: "Run a scheduled task once now when requested. Returns the run and chat IDs without waiting for completion. A busy reused chat is rejected; it is never interrupted. A one-time task is consumed by this run.",
    inputSchema: { type: "object" as const, required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false } },
  { name: "automation_runs", description: "Read recent runs of a desktop scheduled task, including execution state and chat/turn IDs. Full results remain in the corresponding chats.",
    inputSchema: { type: "object" as const, required: ["id"], properties: { id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, additionalProperties: false } },
];
