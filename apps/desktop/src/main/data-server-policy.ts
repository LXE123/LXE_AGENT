export function dataServerRuntimePolicy(packaged: boolean): Record<string, string> {
  return {
    LXE_DATA_SERVER_LOCAL_FALLBACK_ALLOWED: packaged ? "0" : "1",
  };
}
