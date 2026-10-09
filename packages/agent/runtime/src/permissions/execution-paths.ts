import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceArtifactRoot } from "@lxe/core";
import type { ExecutionPolicy } from "./policy";
import { managedPythonStateRoots } from "./managed-python-state";

const sessionKey = (id: string) => createHash("sha256").update(id).digest("hex");

/** Host locations, independent of permission policy. Path derivation never creates or resolves directories. */
export class ExecutionPaths {
  private readonly runtimeId = randomUUID();
  private readonly sessionTemporaryPaths = new Map<string, string>();
  readonly platform: NodeJS.Platform;
  readonly systemTemporaryDirectory: string;
  constructor(readonly dataRoot: string, options: { platform?: NodeJS.Platform; temporaryRoot?: string } = {}) {
    this.platform = options.platform ?? process.platform;
    this.systemTemporaryDirectory = options.temporaryRoot ?? tmpdir();
  }
  artifactRoot(policy: ExecutionPolicy): string { return workspaceArtifactRoot(policy.workspaceRoot); }
  outputDirectory(policy: ExecutionPolicy): string { return join(this.dataRoot, "tmp", "exec", sessionKey(policy.sessionId)); }
  managedPythonStateRoots(): string[] {
    return managedPythonStateRoots(this.dataRoot);
  }
  temporaryDirectory(policy: ExecutionPolicy): string {
    if (this.platform !== "win32" || policy.mode !== "workspace-write") return this.systemTemporaryDirectory;
    const path = join(this.systemTemporaryDirectory, `lxe-${this.runtimeId}-${sessionKey(policy.sessionId)}`);
    this.sessionTemporaryPaths.set(policy.sessionId, path);
    return path;
  }
  sessionTemporaries(): ReadonlyMap<string, string> { return this.sessionTemporaryPaths; }
  forgetTemporary(sessionId: string): void { this.sessionTemporaryPaths.delete(sessionId); }
  temporaryRoots(policy: ExecutionPolicy): string[] {
    if (policy.mode !== "workspace-write") return [];
    return this.platform === "darwin" ? ["/tmp", this.systemTemporaryDirectory] : [this.temporaryDirectory(policy)];
  }
}
