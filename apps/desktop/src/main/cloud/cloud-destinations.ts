import type {
  DesktopCloudConnectionState,
  DesktopCloudDestination,
} from "@lxe/desktop-protocol";

const CLOUD_DESTINATION_PATHS: Record<DesktopCloudDestination, string> = {
  agent_dashboard: "/dashboard",
  erp_dashboard: "/erp",
  admin_dashboard: "/admin",
};

export interface CloudDestinationUrlInput {
  configured: boolean;
  connection: DesktopCloudConnectionState;
  dataServerUrl: string;
  destination: DesktopCloudDestination;
  desktopFeatures: readonly string[];
}

export function resolveCloudDestinationUrl(input: CloudDestinationUrlInput): string {
  if (!input.configured) throw new Error("公司云端尚未配置");
  if (input.connection !== "connected") throw new Error("公司云端当前未连接");
  if (input.destination === "erp_dashboard"
    && !input.desktopFeatures.includes("*")
    && !input.desktopFeatures.includes("erp_dashboard")) {
    throw new Error("当前设备没有 FBA ERP 访问权限");
  }

  let target: URL;
  try {
    target = new URL(input.dataServerUrl.trim());
  } catch {
    throw new Error("公司云端服务器地址无效");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("公司云端服务器地址协议不受支持");
  }

  target.username = "";
  target.password = "";
  target.pathname = CLOUD_DESTINATION_PATHS[input.destination];
  target.search = "";
  target.hash = "";
  return target.toString();
}
