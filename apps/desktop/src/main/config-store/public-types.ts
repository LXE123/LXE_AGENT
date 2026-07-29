import type {
  DesktopConfigImportApplyResult,
  DesktopConfigImportGroupPreview,
  DesktopCloudPermissionSnapshot,
  DesktopPlatform,
} from "@lxe/desktop-protocol";

export interface DesktopCloudConfiguration {
  managed: boolean;
  device_id: string;
  device_name: string;
  vpn_ip: string;
  data_server_url: string;
  tunnel_name: string;
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
}

export type { DesktopCloudPermissionSnapshot };

export interface DesktopConfigStoreOptions {
  platform?: DesktopPlatform;
  pathExists?: (path: string) => boolean;
  pathIsDirectory?: (path: string) => boolean;
  pathIsExecutable?: (path: string) => boolean;
  secretEnvironment?: Readonly<Record<string, string | undefined>>;
}

export interface LegacyEnvironmentMigrationOptions {
  environment: Readonly<Record<string, string | undefined>>;
  managedFiles?: readonly string[];
  retiredFiles?: readonly string[];
}

export interface PreparedDesktopConfigImport {
  summary: {
    groups: DesktopConfigImportGroupPreview[];
    warnings: string[];
    diagnostic_logging: boolean;
  };
  apply(): DesktopConfigImportApplyResult;
}
