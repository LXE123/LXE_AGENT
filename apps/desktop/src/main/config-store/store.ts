import type {
  DesktopCloudPermissionSnapshot,
  CredentialSource,
  DesktopLocalModelCredentialInput,
  DesktopModelProvider,
  DesktopSetupInput,
  DesktopSetupState,
  ManagedLlmCredential,
} from "@lxe/desktop-protocol";
import { DesktopCloudConfigService } from "./cloud";
import { DesktopLocalAuthStore } from "./auth-store";
import type {
  DesktopCloudConfiguration,
  DesktopCloudEnrollmentConfig,
  DesktopConfigStoreOptions,
} from "./public-types";
import { DesktopConfigRepository, type SafeStoragePort } from "./repository";
import { DesktopSetupService } from "./setup";
import { DesktopConfigValidation } from "./validation";

export class DesktopConfigStore {
  private readonly setup: DesktopSetupService;
  private readonly cloud: DesktopCloudConfigService;

  constructor(
    dataRoot: string,
    defaultWorkspaceRoot: string,
    safeStorage: SafeStoragePort,
    options: DesktopConfigStoreOptions = {},
  ) {
    const validation = new DesktopConfigValidation(options);
    const repository = new DesktopConfigRepository(dataRoot, safeStorage, validation.platform);
    const auth = new DesktopLocalAuthStore(dataRoot, validation.platform);
    this.setup = new DesktopSetupService(
      dataRoot,
      defaultWorkspaceRoot,
      repository,
      auth,
      validation,
      options.secretEnvironment,
    );
    this.cloud = new DesktopCloudConfigService(repository, options.secretEnvironment);
    this.setup.migrateModelCredentialStorage();
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

  managedLlmCredential(): ManagedLlmCredential | null {
    return this.setup.managedLlmCredential();
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

  cloudPermissionSnapshot(): DesktopCloudPermissionSnapshot | null {
    return this.cloud.permissionSnapshot();
  }

  saveCloudPermissionSnapshot(
    snapshot: DesktopCloudPermissionSnapshot,
  ): DesktopCloudPermissionSnapshot {
    return this.cloud.savePermissionSnapshot(snapshot);
  }

  environment(): Record<string, string> {
    return this.setup.environment();
  }
}
