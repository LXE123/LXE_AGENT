/** Public directory projection; never includes local paths, prompts or credentials. */
export interface TeamCatalogSkill {
  name: string;
  description: string;
  type: string;
  source: "repository" | "user" | "shared";
}

export interface TeamCatalogSnapshot {
  schemaVersion: 1;
  sourceId: string;
  sourceLabel: string;
  revision: number;
  collectedAt: string;
  skills: TeamCatalogSkill[];
}

export interface TeamCatalogReceipt {
  sourceId: string;
  revision: number;
  receivedAt: string;
  skillCount: number;
}

export interface TeamCatalogSettingsInput {
  endpoint: string;
  sourceLabel: string;
  /** Omit or leave empty to retain the current key for the same endpoint. */
  apiKey?: string;
}

export interface TeamCatalogState {
  endpoint: string;
  sourceLabel: string;
  sourceId: string;
  configured: boolean;
  syncing: boolean;
  lastSync: TeamCatalogReceipt | null;
}

export interface TeamCatalogBridge {
  state(): Promise<TeamCatalogState>;
  save(input: TeamCatalogSettingsInput): Promise<TeamCatalogState>;
  sync(): Promise<TeamCatalogState>;
}
