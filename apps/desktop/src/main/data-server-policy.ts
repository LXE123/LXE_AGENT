type Environment = Readonly<Record<string, string | undefined>>;

const DATA_SERVER_RUNTIME_KEYS = [
  "LXE_DATA_SERVER_ENABLED",
  "LXE_DATA_SERVER_URL",
  "LXE_DATA_SERVER_API_KEY",
  "LXE_DATA_SERVER_SYNC_INTERVAL_SECONDS",
  "LXE_DATA_SERVER_REQUEST_TIMEOUT_SECONDS",
  "LXE_DATA_SERVER_LOCAL_FALLBACK_ENABLED",
  "LXE_DATA_SERVER_FALLBACK_URL",
  "LXE_DATA_SERVER_FALLBACK_API_KEY",
  "LXE_ERP_API_KEY",
] as const;

export interface DataServerRuntimeEnvironmentOptions {
  packaged: boolean;
  sourceEnvironment: Environment;
  managedEnvironment: Environment;
  machineIdentityPath: string;
}

export function withoutDataServerEnvironment(environment: Environment): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !name.startsWith("LXE_DATA_SERVER_") && name !== "LXE_ERP_API_KEY",
    ),
  );
}

export function resolveDataServerRuntimeEnvironment(
  options: DataServerRuntimeEnvironmentOptions,
): Record<string, string> {
  const selected = options.packaged ? options.managedEnvironment : options.sourceEnvironment;
  const environment: Record<string, string> = {};
  for (const name of DATA_SERVER_RUNTIME_KEYS) {
    const value = selected[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.LXE_DATA_SERVER_LOCAL_FALLBACK_ALLOWED = options.packaged ? "0" : "1";
  environment.LXE_DATA_SERVER_MACHINE_ID_PATH = options.machineIdentityPath;
  return environment;
}
