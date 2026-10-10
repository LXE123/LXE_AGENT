import type { ComponentProps } from "react";
import type { DashboardRpcResult } from "@lxe/desktop-protocol";
import { queryError } from "../../api/queries";
import { useUiText } from "../../shared/i18n";
import type { CapabilityView } from "../../shared/navigation";
import { EmptyState } from "../../shared/components";
import { WorkspaceView } from "../../shared/workspace-view";
import { ModelsView } from "../models/view";
import { SkillsCatalogView } from "../skills/user-view";
import { AddSkillMenu } from "../skills/add-menu";
import { ToolsView } from "../tools/view";
import { McpServicesView } from "../integrations/view";
import type { DetailTarget } from "../../shared/ui/detail-target";

type QueryView<T> = Readonly<{ data: T | undefined; isPending: boolean; error: unknown }>;
type Props = Readonly<{
  capabilityView: CapabilityView;
  openCapabilityView: (view: CapabilityView) => void;
  dashboardRuntimeReady: boolean;
  modelsQuery: QueryView<DashboardRpcResult<"models.list">>;
  currentModelQuery: QueryView<DashboardRpcResult<"models.current">>;
  skillsQuery: QueryView<DashboardRpcResult<"skills.list">>;
  commandsQuery: QueryView<DashboardRpcResult<"commands.list">>;
  toolsetsQuery: QueryView<DashboardRpcResult<"toolsets.list">>;
  onOpenDetail: (target: DetailTarget) => void;
  startSkillConversation: ComponentProps<typeof SkillsCatalogView>["onConversation"];
  mcpSavingId: ComponentProps<typeof McpServicesView>["mcpSavingId"];
  toggleMcpServer: ComponentProps<typeof McpServicesView>["onToggleMcpServer"];
}>;

export function CapabilitiesPage({ capabilityView, openCapabilityView, dashboardRuntimeReady,
  modelsQuery, currentModelQuery, skillsQuery, commandsQuery, toolsetsQuery,
  onOpenDetail, startSkillConversation, mcpSavingId, toggleMcpServer }: Props) {
  const t = useUiText();
  const capabilityItems: Array<{ id: CapabilityView; label: string }> = [
    { id: "skills", label: t.nav.skills },
    { id: "tools", label: t.nav.tools },
    { id: "connections", label: t.nav.connections },
    { id: "models", label: t.nav.models },
  ];

  const mcpToolset = toolsetsQuery.data?.items.find((toolset) => toolset.name === "mcp");
  return (
    <WorkspaceView
      activeView={capabilityView}
      items={capabilityItems}
      label={t.nav.capabilities}
      onSelect={openCapabilityView}
      actions={capabilityView === "skills" ? <AddSkillMenu disabled={!dashboardRuntimeReady}
        onAdd={() => startSkillConversation("create")} /> : undefined}
    >
      {capabilityView === "models" ? (
        !dashboardRuntimeReady ? <EmptyState label={t.conversation.unavailable} />
          : modelsQuery.isPending || currentModelQuery.isPending ? <EmptyState label={t.common.loading} />
          : !modelsQuery.data || !currentModelQuery.data
            ? <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(modelsQuery.error || currentModelQuery.error))} />
            : <ModelsView
                models={modelsQuery.data.items}
                current={currentModelQuery.data}
              />
      ) : null}
      {capabilityView === "skills" ? (
        !dashboardRuntimeReady ? <EmptyState label={t.conversation.unavailable} />
          : skillsQuery.isPending || commandsQuery.isPending ? <EmptyState label={t.common.loading} />
          : skillsQuery.data && commandsQuery.data
            ? <SkillsCatalogView
                skills={skillsQuery.data.items}
                commands={commandsQuery.data.items}
                onOpen={onOpenDetail}
                onConversation={startSkillConversation}
              />
            : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(skillsQuery.error || commandsQuery.error))} />
      ) : null}
      {capabilityView === "tools" ? (
        !dashboardRuntimeReady ? <EmptyState label={t.conversation.unavailable} />
          : toolsetsQuery.isPending ? <EmptyState label={t.common.loading} />
          : toolsetsQuery.data
            ? <ToolsView toolsets={toolsetsQuery.data.items} onOpen={onOpenDetail} />
            : <EmptyState label={t.common.errorPrefix(t.errors.api, queryError(toolsetsQuery.error))} />
      ) : null}
      {capabilityView === "connections" ? (
        !dashboardRuntimeReady ? <EmptyState label={t.conversation.unavailable} />
          : toolsetsQuery.isPending ? <EmptyState label={t.common.loading} />
          : <McpServicesView
              mcpError={!toolsetsQuery.data ? queryError(toolsetsQuery.error) : ""}
              mcpSavingId={mcpSavingId}
              mcpToolset={mcpToolset}
              onToggleMcpServer={toggleMcpServer}
            />
      ) : null}
    </WorkspaceView>
  );
}
