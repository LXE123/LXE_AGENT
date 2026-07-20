import { join } from "node:path";

export interface RuntimeConfigPaths {
  root: string;
  providers: string;
  authProfiles: string;
}

export function runtimeConfigPaths(projectRoot: string): RuntimeConfigPaths {
  return runtimeConfigPathsFromRoot(join(projectRoot, "config", "llm"));
}

export function runtimeConfigPathsFromRoot(root: string): RuntimeConfigPaths {
  return {
    root,
    providers: join(root, "providers"),
    authProfiles: join(root, "auth-profiles.json"),
  };
}
