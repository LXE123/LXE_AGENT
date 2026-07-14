import { join } from "node:path";

export interface RuntimeConfigPaths {
  root: string;
  providers: string;
  authProfiles: string;
}

export function runtimeConfigPaths(projectRoot: string): RuntimeConfigPaths {
  const root = join(projectRoot, "config", "llm");
  return {
    root,
    providers: join(root, "providers"),
    authProfiles: join(root, "auth-profiles.json"),
  };
}
