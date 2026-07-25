import type { DesktopSetupInput, DesktopSetupState } from "@lxe/desktop-protocol";
import { DesktopCloudConfigService } from "./cloud";
import { DesktopEnvironmentImport } from "./environment-import";
import { LegacyEnvironmentMigration } from "./legacy-environment";
import type {
  DesktopCloudConfiguration,
  DesktopCloudEnrollmentConfig,
  DesktopConfigStoreOptions,
  LegacyEnvironmentMigrationOptions,
  PreparedDesktopConfigImport,
} from "./public-types";
import { DesktopConfigRepository, type SafeStoragePort } from "./repository";
import { DesktopSetupService } from "./setup";
import { DesktopConfigValidation } from "./validation";

export class DesktopConfigStore {
  private readonly setup: DesktopSetupService;
  private readonly cloud: DesktopCloudConfigService;
  private readonly environmentImport: DesktopEnvironmentImport;
  private readonly legacyEnvironment: LegacyEnvironmentMigration;

  constructor(
    dataRoot: string,
    defaultWorkspaceRoot: string,
    safeStorage: SafeStoragePort,
    options: DesktopConfigStoreOptions = {},
  ) {
    const validation = new DesktopConfigValidation(options);
    const repository = new DesktopConfigRepository(dataRoot, safeStorage, validation.platform);
    this.setup = new DesktopSetupService(
      dataRoot,
      defaultWorkspaceRoot,
      repository,
      validation,
      options.secretEnvironment,
    );
    this.cloud = new DesktopCloudConfigService(repository, options.secretEnvironment);
    this.environmentImport = new DesktopEnvironmentImport(repository, this.setup, validation);
    this.legacyEnvironment = new LegacyEnvironmentMigration(repository, this.setup, validation);
  }

  state(): DesktopSetupState {
    return this.setup.state();
  }

  save(input: DesktopSetupInput): DesktopSetupState {
    return this.setup.save(input);
  }

  saveRuntimePreference(provider: string, model: string, thinkingLevel: string): void {
    this.setup.saveRuntimePreference(provider, model, thinkingLevel);
  }

  cloudConfiguration(): DesktopCloudConfiguration {
    return this.cloud.configuration();
  }

  saveCloudEnrollment(input: DesktopCloudEnrollmentConfig): DesktopCloudConfiguration {
    return this.cloud.saveEnrollment(input);
  }

  migrateLegacyEnvironment(options: LegacyEnvironmentMigrationOptions): DesktopSetupState {
    return this.legacyEnvironment.migrate(options);
  }

  prepareEnvironmentImport(
    environment: Readonly<Record<string, string | undefined>>,
  ): PreparedDesktopConfigImport {
    return this.environmentImport.prepare(environment);
  }

  environment(): Record<string, string> {
    return this.setup.environment();
  }
}
