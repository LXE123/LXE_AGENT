import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

export interface ArtifactMigrationReport {
  version: 1;
  source: string;
  destination: string;
  started_at: string;
  completed_at: string;
  copied: string[];
  skipped: string[];
  errors: Array<{ path: string; message: string }>;
}

const copyMissingFiles = (
  sourceRoot: string,
  destinationRoot: string,
  report: ArtifactMigrationReport,
): void => {
  if (!existsSync(sourceRoot)) return;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const relativePath = relative(sourceRoot, source).replaceAll("\\", "/");
      const destination = join(destinationRoot, relativePath);
      if (entry.isDirectory()) {
        walk(source);
        continue;
      }
      if (!entry.isFile()) continue;
      if (existsSync(destination)) {
        report.skipped.push(relativePath);
        continue;
      }
      try {
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination, constants.COPYFILE_EXCL);
        report.copied.push(relativePath);
      } catch (cause) {
        report.errors.push({
          path: relativePath,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  };
  walk(sourceRoot);
};

export function migrateLegacyArtifacts(options: {
  legacyRoot: string;
  dataRoot: string;
  now?: () => Date;
}): ArtifactMigrationReport {
  const markerPath = join(options.dataRoot, "migrations", "artifacts-v1.json");
  if (existsSync(markerPath)) {
    return JSON.parse(readFileSync(markerPath, "utf8")) as ArtifactMigrationReport;
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const report: ArtifactMigrationReport = {
    version: 1,
    source: join(options.legacyRoot, "artifacts"),
    destination: join(options.dataRoot, "artifacts"),
    started_at: startedAt,
    completed_at: "",
    copied: [],
    skipped: [],
    errors: [],
  };
  copyMissingFiles(report.source, report.destination, report);
  report.completed_at = now().toISOString();
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export function bootstrapDesktopState(resourceRoot: string, dataRoot: string): void {
  const configRoot = join(dataRoot, "config");
  mkdirSync(configRoot, { recursive: true });
  const mcpTarget = join(configRoot, "mcp_servers.local.yaml");
  const mcpSource = join(resourceRoot, "config", "mcp_servers.example.yaml");
  if (!existsSync(mcpTarget) && existsSync(mcpSource) && statSync(mcpSource).isFile()) {
    copyFileSync(mcpSource, mcpTarget, constants.COPYFILE_EXCL);
  }
  const connectorState = join(configRoot, "connector-states.local.json");
  if (!existsSync(connectorState)) writeFileSync(connectorState, "{}\n", "utf8");
}
