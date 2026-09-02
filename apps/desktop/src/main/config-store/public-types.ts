import type { DesktopCloudPermissionSnapshot, DesktopPlatform } from "@lxe/desktop-protocol";
import type { WireGuardTunnelConfiguration } from "../wireguard-types";

export interface DesktopCloudConfiguration {
  managed: boolean;
  device_id: string;
  device_name: string;
  vpn_ip: string;
  data_server_url: string;
  tunnel_name: string;
  switch_in_progress: boolean;
  api_key_configured: boolean;
}

export interface DesktopCloudEnrollmentConfig {
  deviceId: string;
  deviceName: string;
  vpnIp: string;
  dataServerUrl: string;
  tunnelName: string;
  apiKey: string;
  erpApiKey?: string;
  wireGuard?: WireGuardTunnelConfiguration;
}

export type { DesktopCloudPermissionSnapshot };

export interface DesktopConfigStoreOptions {
  platform?: DesktopPlatform;
  llmConfigRoot?: string;
  pathExists?: (path: string) => boolean;
  pathIsDirectory?: (path: string) => boolean;
  pathIsExecutable?: (path: string) => boolean;
  secretEnvironment?: Readonly<Record<string, string | undefined>>;
}
