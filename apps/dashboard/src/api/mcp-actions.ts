import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { McpServerAddInput } from "@lxe/desktop-protocol";
import { callDashboard } from "./client";
import { dashboardQueryKeys } from "./query-keys";
import { queryError } from "./queries";
import type { McpServerListPayload, McpServerPayload } from "./payloads";

export function addMcpServer(input: McpServerAddInput) {
  return callDashboard({ operation: "mcp.servers.add", input });
}

export function useMcpActions(onError: (message: string) => void) {
  const queryClient = useQueryClient();
  const mcpMutation = useMutation<
    McpServerPayload,
    unknown,
    McpServerPayload,
    { servers?: McpServerListPayload }
  >({
    mutationFn: (server) => callDashboard({
      operation: "mcp.servers.update",
      input: { name: server.name, enabled: !server.enabled },
    }),
    onMutate: async (server) => {
      onError("");
      await queryClient.cancelQueries({ queryKey: dashboardQueryKeys.mcpServers.all });
      const servers = queryClient.getQueryData<McpServerListPayload>(dashboardQueryKeys.mcpServers.all);
      const nextEnabled = !server.enabled;
      queryClient.setQueryData<McpServerListPayload | undefined>(
        dashboardQueryKeys.mcpServers.all,
        (current) => current ? {
          ...current,
          items: current.items.map((item) => item.name === server.name ? {
            ...item,
            enabled: nextEnabled,
          } : item),
        } : current,
      );
      return { servers };
    },
    onError: (cause, _server, context) => {
      queryClient.setQueryData(dashboardQueryKeys.mcpServers.all, context?.servers);
      onError(queryError(cause));
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.mcpServers.all }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.tools.all }),
      ]);
    },
  });

  function toggleMcpServer(server: McpServerPayload) {
    if (!mcpMutation.isPending) mcpMutation.mutate(server);
  }
  return { toggleMcpServer, savingId: mcpMutation.isPending ? mcpMutation.variables?.name || "" : "" } as const;
}
