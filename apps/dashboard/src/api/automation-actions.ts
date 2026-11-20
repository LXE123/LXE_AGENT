import type { AutomationDefinition, AutomationRpcSpec } from "@lxe/desktop-protocol";
import { callDashboard } from "./client";

export const automationActions = {
  list: () => callDashboard({operation:"automations.list",input:{}}),
  save: (input: AutomationRpcSpec["automations.save"]["input"]) => callDashboard({operation:"automations.save",input}),
  status: (id: string, version: number, status: "active" | "paused") => callDashboard({operation:"automations.status",input:{id,version,status}}),
  delete: (id: string, version: number) => callDashboard({operation:"automations.delete",input:{id,version}}),
  run: (id: string) => callDashboard({operation:"automations.run",input:{id}}),
  runs: (id: string) => callDashboard({operation:"automations.runs",input:{id}}),
  preview: (definition: AutomationDefinition) => callDashboard({operation:"automations.preview",input:{definition}}),
  editing: (session_id: string, editing: boolean) => callDashboard({operation:"automations.editing",input:{session_id,editing}}),
  sessions: (query: string) => callDashboard({operation:"sessions.list",input:{query,limit:200,offset:0}}),
};
