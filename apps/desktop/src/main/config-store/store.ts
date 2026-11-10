import type { ManagedLlmState } from "@lxe/core";
import type {
  DesktopCloudPermissionSnapshot,
  CredentialSource,
  DesktopLocalModelCredentialInput,
  DesktopModelProvider,
  DesktopSetupInput,
  DesktopSetupState,
  ManagedLlmCredential,
  ManagedLlmTarget,
} from "@lxe/desktop-protocol";
import { loadLlmProviderCatalog, sanitizeLogValueWithPolicy } from "@lxe/core";
import { join } from "node:path";
import { DesktopCloudConfigService } from "./cloud";
import { DesktopLocalAuthStore } from "./auth-store";
import type {
  DesktopCloudConfiguration,
  DesktopCloudEnrollmentConfig,
  DesktopConfigStoreOptions,
} from "./public-types";
import type { WireGuardTunnelConfiguration } from "../wireguard-types";
import { DesktopConfigRepository, type SafeStoragePort } from "./repository";
import { DesktopSetupService } from "./setup";
import { DesktopConfigValidation } from "./validation";
import { agentAccessGrant, renewMcpGrant, type DesktopMcpGrant } from "../mcp-oauth";
import type { McpAccessGrant } from "@lxe/desktop-protocol";
import { OAuthError } from "@modelcontextprotocol/client";

export class DesktopConfigStore {
  private readonly renewals = new Map<string, Promise<McpAccessGrant | null>>();
  private readonly repository: DesktopConfigRepository;
  private readonly setup: DesktopSetupService;
  private readonly cloud: DesktopCloudConfigService;

  constructor(
    dataRoot: string,
    defaultWorkspaceRoot: string,
    safeStorage: SafeStoragePort,
    options: DesktopConfigStoreOptions = {},
  ) {
    const validation = new DesktopConfigValidation(options);
    const llmConfigRoot = options.llmConfigRoot ?? join(process.cwd(), "config", "llm");
    const catalog = loadLlmProviderCatalog(llmConfigRoot);
    const repository = new DesktopConfigRepository(dataRoot, safeStorage, validation.platform, catalog);
    this.repository = repository;
    const auth = new DesktopLocalAuthStore(
      dataRoot,
      validation.platform,
      catalog.providers.map((provider) => provider.name),
    );
    this.setup = new DesktopSetupService(
      dataRoot,
      defaultWorkspaceRoot,
      repository,
      auth,
      validation,
      catalog,
      options.secretEnvironment,
      llmConfigRoot,
    );
    this.cloud = new DesktopCloudConfigService(repository);
    this.setup.migrateModelCredentialStorage();
    this.cloud.migrateManagedLlmOwner();
  }

  mcpAccessGrants() { return (this.repository.readSecrets().mcp_access_grants ?? []).map(agentAccessGrant); }

  mcpCredential(name: string, url: string) {
    return this.repository.readSecrets().mcp_access_grants?.find(grant => grant.name === name && grant.url === url);
  }

  async refreshMcpAccessGrant(request: McpAccessGrant): Promise<McpAccessGrant | null> {
    const current = this.mcpCredential(request.name, request.url);
    if (!current) return null;
    if (current.access_token !== request.access_token || !current.renewal) return agentAccessGrant(current);
    const key = JSON.stringify([request.name, request.url]);
    const pending = this.renewals.get(key);
    if (pending) return pending;
    const refresh = this.renewSavedGrant(current);
    this.renewals.set(key, refresh);
    try { return await refresh; }
    finally { this.renewals.delete(key); }
  }

  private async renewSavedGrant(current: DesktopMcpGrant): Promise<McpAccessGrant | null> {
    let refreshed: DesktopMcpGrant;
    try { refreshed = await renewMcpGrant(current); }
    catch (error) {
      const latest = this.mcpCredential(current.name, current.url);
      if (latest?.access_token !== current.access_token || latest.renewal?.refresh_token !== current.renewal?.refresh_token) {
        return latest ? agentAccessGrant(latest) : null;
      }
      if (error instanceof OAuthError && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.code)) {
        const { renewal, ...accessOnly } = latest;
        this.saveMcpAccessGrant(accessOnly);
      }
      // The issuer's error can quote credentials. Preserve the reason without those values.
      let message = error instanceof OAuthError ? error.code + ": " + error.message : error instanceof Error ? error.message : String(error);
      for (const secret of [current.access_token, current.renewal?.refresh_token, current.renewal?.client.client_secret]) {
        if (secret) message = message.replaceAll(secret, "[redacted]");
      }
      throw new Error(String(sanitizeLogValueWithPolicy(message, { maxString: 8192 })));
    }
    const latest = this.mcpCredential(current.name, current.url);
    if (!latest) return null;
    if (latest.access_token !== current.access_token || latest.renewal?.refresh_token !== current.renewal?.refresh_token) {
      return agentAccessGrant(latest);
    }
    this.saveMcpAccessGrant(refreshed);
    return agentAccessGrant(refreshed);
  }

  saveMcpAccessGrant(grant: DesktopMcpGrant): void {
    const config = this.repository.readConfig();
    const secrets = this.repository.readSecrets();
    secrets.mcp_access_grants = [...(secrets.mcp_access_grants ?? []).filter(item => item.name !== grant.name), grant];
    this.repository.commit(config, secrets);
  }

  state(): DesktopSetupState {
    return this.setup.state();
  }

  save(input: DesktopSetupInput): DesktopSetupState {
    return this.setup.save(input);
  }

  saveLocalModelCredential(input: DesktopLocalModelCredentialInput): DesktopSetupState {
    return this.setup.saveLocalModelCredential(input);
  }

  deleteLocalModelCredential(provider: DesktopModelProvider): DesktopSetupState {
    return this.setup.deleteLocalModelCredential(provider);
  }

  saveRuntimePreference(
    provider: string,
    model: string,
    thinkingLevel: string,
    credentialSource: CredentialSource = "local",
  ): void {
    this.setup.saveRuntimePreference(provider, model, thinkingLevel, credentialSource);
  }

  deepSeekBalanceCredential() { return this.setup.deepSeekBalanceCredential(); }

  managedLlmState(): ManagedLlmState { return this.setup.managedLlmState(); }

  saveManagedLlmState(state: ManagedLlmState): void { this.setup.saveManagedLlmState(state); }

  managedLlmCredential(): ManagedLlmCredential | null {
    return this.setup.managedLlmCredential();
  }

  managedLlmTarget(): ManagedLlmTarget {
    return this.setup.managedLlmTarget();
  }

  saveManagedLlmTarget(target: ManagedLlmTarget): void {
    this.setup.saveManagedLlmTarget(target);
  }

  saveManagedLlmCredential(credential: ManagedLlmCredential): void {
    this.setup.saveManagedLlmCredential(credential);
  }

  invalidateManagedLlmCredential(revision: string): void {
    this.setup.invalidateManagedLlmCredential(revision);
  }

  clearManagedLlmCredential(): void {
    this.setup.clearManagedLlmCredential();
  }

  cloudConfiguration(): DesktopCloudConfiguration {
    return this.cloud.configuration();
  }

  cloudIdentityCredential(): string { return this.cloud.identityCredential(); }
  cloudLegacyIdentityCredential(): string { return this.cloud.legacyIdentityCredential(); }
  cloudMigrationCandidate(legacyToken: string): string { return this.cloud.migrationCandidate(legacyToken); }
  completeCloudIdentityMigration(legacyToken: string, candidate: string): void {
    this.cloud.completeIdentityMigration(legacyToken, candidate);
  }
  saveCloudEnrollment(input: DesktopCloudEnrollmentConfig): DesktopCloudConfiguration {
    return this.cloud.saveEnrollment(input);
  }

  beginCloudEnrollmentSwitch(): DesktopCloudConfiguration {
    return this.cloud.beginSwitch();
  }

  abortCloudEnrollmentSwitch(): DesktopCloudConfiguration {
    return this.cloud.abortSwitch();
  }

  clearCloudEnrollment(): DesktopCloudConfiguration {
    return this.cloud.clearEnrollment();
  }

  recoverInterruptedCloudEnrollmentSwitch(): boolean {
    return this.cloud.recoverInterruptedSwitch();
  }

  managedLlmOwner() { return this.cloud.managedLlmOwner(); }
  managedLlmVerifiedAt(): number { return this.cloud.managedLlmVerifiedAt(); }
  saveManagedLlmOwner(owner: import("@lxe/desktop-protocol").DesktopObservedDevice | null, verifiedAt = 0): void { this.cloud.saveManagedLlmOwner(owner, verifiedAt); }

  cloudObservedDevice() { return this.cloud.observedDevice(); }

  cloudPermissionSnapshot(): DesktopCloudPermissionSnapshot | null {
    return this.cloud.permissionSnapshot();
  }

  cloudWireGuardConfiguration(): WireGuardTunnelConfiguration | null {
    return this.cloud.wireGuardConfiguration();
  }

  clearCloudPermissionSnapshot(): void { this.cloud.clearPermissionSnapshot(); }

  saveCloudPermissionSnapshot(
    snapshot: DesktopCloudPermissionSnapshot,
  ): DesktopCloudPermissionSnapshot {
    return this.cloud.savePermissionSnapshot(snapshot);
  }

  environment(): Record<string, string> {
    return this.setup.environment();
  }
}
