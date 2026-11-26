import type {
  DashboardRpcCall,
  DashboardRpcOperation,
  DashboardRpcResult,
  DesktopFileCall,
  DesktopFileOperations,
} from "@lxe/desktop-protocol";
import type { DirectGatewayComposition, ProcessAgentRuntime } from "@lxe/gateway/desktop";
import type { DesktopConfigStore } from "../../config-store";
import type { DesktopConversationAttachmentService } from "../../conversations/conversation-attachments";
import type { ConversationImagePreviewDependencies } from "../../conversations/conversation-artifacts";
import type { ElectronInboundImageProcessor } from "../../conversations/inbound-image";
import type { DesktopAutomations } from "../automations";
import type { NodeGatewayStore } from "../gateway-store";

/** What a Dashboard handler may use once the Gateway and agentcli are ready. */
export interface DashboardHandlerContext {
  readonly parts: DirectGatewayComposition["parts"];
  readonly runtime: ProcessAgentRuntime;
  readonly store: NodeGatewayStore | undefined;
  readonly automations: DesktopAutomations | undefined;
  readonly attachments: DesktopConversationAttachmentService;
  readonly config: DesktopConfigStore;
  readonly beforeDeleteSession: ((sessionId: string) => Promise<void>) | undefined;
  prepareImage(...args: Parameters<ElectronInboundImageProcessor["prepareModelBlock"]>):
    ReturnType<ElectronInboundImageProcessor["prepareModelBlock"]>;
  fileCall<K extends keyof DesktopFileOperations>(call: DesktopFileCall<K>): Promise<DesktopFileOperations[K]["result"]>;
  collectPastedText(sessionId: string): Promise<void>;
  /** Thumbnail makers use Electron's nativeImage, so the Gateway supplies them. */
  readonly thumbnails: Pick<ConversationImagePreviewDependencies, "thumbnail" | "imageThumbnail">;
}

export type DashboardHandler<O extends DashboardRpcOperation> =
  (call: DashboardRpcCall<O>, context: DashboardHandlerContext) => Promise<DashboardRpcResult<O>>;

/** Operations Desktop handles itself; any operation missing here goes to agentcli unchanged. */
export type DashboardHandlers = { [O in DashboardRpcOperation]?: DashboardHandler<O> };
