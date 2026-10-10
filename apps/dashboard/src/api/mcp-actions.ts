import { useMutation, useQueryClient } from "@tanstack/react-query";
import { callDashboard } from "./client";
import { dashboardQueryKeys } from "./query-keys";
import { queryError } from "./queries";
import type { ApiList, McpServerPayload, ToolsetPayload } from "./payloads";

export function useMcpActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const mcpMutation = useMutation<
    McpServerPayload,
    unknown,
    McpServerPayload,
    { toolsets?: ApiList<ToolsetPayload> }
  >({
    mutationFn: (server) => callDashboard({
      operation: "mcp.servers.update",
      input: { name: server.name, enabled: !server.enabled },
    }),
    onMutate: async (server) => {
      onError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.tools.all });
      const toolsets = queryClient.getQueryData<ApiList<ToolsetPayload>>(dashboardQueryKeys.tools.all);
      const nextEnabled = !server.enabled;
      queryClient.setQueryData<ApiList<ToolsetPayload> | undefined>(
        dashboardQueryKeys.tools.all,
        (current) => current ? {
          ...current,
          items: current.items.map((toolset) => toolset.name === "mcp" ? {
            ...toolset,
            servers: (toolset.servers || []).map((item) => item.name === server.name ? {
              ...item,
              enabled: nextEnabled,
              status: nextEnabled ? item.status : "disabled",
            } : item),
          } : toolset),
        } : current,
      );
      return { toolsets };
    },
    onError: (cause, _server, context) => {
      queryClient.setQueryData(dashboardQueryKeys.tools.all, context?.toolsets);
      onError(queryError(cause));
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.tools.all });
    },
  });

  function toggleMcpServer(server: McpServerPayload) {
    if (!mcpMutation.isPending) mcpMutation.mutate(server);
  }
  return { toggleMcpServer, savingId: mcpMutation.isPending ? mcpMutation.variables?.name || "" : "" } as const;
}
