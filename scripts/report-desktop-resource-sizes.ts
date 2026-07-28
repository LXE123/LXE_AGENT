import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
export const DESKTOP_RUNTIME_BUDGET_BYTES = 950 * MIB;
export const DESKTOP_UNPACKED_BUDGET_BYTES = Math.floor(1.3 * GIB);

export interface SizeSummary {
  bytes: number;
  mib: number;
  files: number;
}

interface BudgetSummary {
  bytes: number;
  mib: number;
  limit_bytes: number;
  limit_mib: number;
  passed: boolean;
}

export interface DesktopResourceSizeReport {
  schema_version: 1;
  platform: "win32-x64";
  root: string;
  total: SizeSummary;
  electron: SizeSummary;
  resources: {
    total: SizeSummary;
    runtime: {
      total: SizeSummary;
      node: {
        total: SizeSummary;
        node_modules: SizeSummary;
        npm_cache: SizeSummary;
      };
      python: {
        total: SizeSummary;
        playwright: SizeSummary;
        playwright_driver_node: SizeSummary;
      };
      playwright: SizeSummary;
      agent_cli: SizeSummary;
      uv: SizeSummary;
      tools: {
        total: SizeSummary;
        ripgrep: SizeSummary;
        exiftool: SizeSummary;
        exiftool_executable: SizeSummary;
        exiftool_support: SizeSummary;
      };
    };
    dashboard: SizeSummary;
    agent: SizeSummary;
    skills: SizeSummary;
    lxeskill: SizeSummary;
    config: SizeSummary;
    branding: SizeSummary;
    wireguard: SizeSummary;
    legal: SizeSummary;
  };
  budgets: {
    runtime: BudgetSummary;
    unpacked: BudgetSummary;
  };
}

const emptySummary = (): SizeSummary => ({ bytes: 0, mib: 0, files: 0 });

const finishSummary = (bytes: number, files: number): SizeSummary => ({
  bytes,
  mib: Number((bytes / MIB).toFixed(2)),
  files,
});

const addSummary = (target: SizeSummary, source: SizeSummary): void => {
  target.bytes += source.bytes;
  target.files += source.files;
  target.mib = Number((target.bytes / MIB).toFixed(2));
};

export const summarizePath = (path: string): SizeSummary => {
  if (!existsSync(path)) return emptySummary();
  const metadata = statSync(path);
  if (metadata.isFile()) return finishSummary(metadata.size, 1);
  if (!metadata.isDirectory()) return emptySummary();

  const summary = emptySummary();
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    addSummary(summary, summarizePath(join(path, entry.name)));
  }
  return summary;
};

const summarizeChildrenExcept = (root: string, excludedNames: ReadonlySet<string>): SizeSummary => {
  if (!existsSync(root)) return emptySummary();
  const summary = emptySummary();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue;
    addSummary(summary, summarizePath(join(root, entry.name)));
  }
  return summary;
};

const budgetSummary = (actual: SizeSummary, limitBytes: number): BudgetSummary => ({
  bytes: actual.bytes,
  mib: actual.mib,
  limit_bytes: limitBytes,
  limit_mib: Number((limitBytes / MIB).toFixed(2)),
  passed: actual.bytes <= limitBytes,
});

export const createDesktopResourceSizeReport = (unpackedRoot: string): DesktopResourceSizeReport => {
  const root = resolve(unpackedRoot);
  if (!existsSync(join(root, "LXE Agent.exe"))) {
    throw new Error(`Windows unpacked desktop executable is missing: ${join(root, "LXE Agent.exe")}`);
  }

  const resourcesRoot = join(root, "resources");
  const runtimeRoot = join(resourcesRoot, "runtime");
  const total = summarizePath(root);
  const runtime = summarizePath(runtimeRoot);
  return {
    schema_version: 1,
    platform: "win32-x64",
    root,
    total,
    electron: summarizeChildrenExcept(root, new Set(["resources"])),
    resources: {
      total: summarizePath(resourcesRoot),
      runtime: {
        total: runtime,
        node: {
          total: summarizePath(join(runtimeRoot, "node")),
          node_modules: summarizePath(join(runtimeRoot, "node", "node_modules")),
          npm_cache: summarizePath(join(runtimeRoot, "node", "npm-cache")),
        },
        python: {
          total: summarizePath(join(runtimeRoot, "python")),
          playwright: summarizePath(join(runtimeRoot, "python", "Lib", "site-packages", "playwright")),
          playwright_driver_node: summarizePath(join(
            runtimeRoot,
            "python",
            "Lib",
            "site-packages",
            "playwright",
            "driver",
            "node.exe",
          )),
        },
        playwright: summarizePath(join(runtimeRoot, "playwright")),
        agent_cli: summarizePath(join(runtimeRoot, "agent-cli")),
        uv: summarizePath(join(runtimeRoot, "uv")),
        tools: {
          total: summarizePath(join(runtimeRoot, "tools")),
          ripgrep: summarizePath(join(runtimeRoot, "tools", "rg.exe")),
          exiftool: summarizePath(join(runtimeRoot, "tools", "exiftool")),
          exiftool_executable: summarizePath(join(runtimeRoot, "tools", "exiftool", "exiftool.exe")),
          exiftool_support: summarizePath(join(runtimeRoot, "tools", "exiftool", "exiftool_files")),
        },
      },
      dashboard: summarizePath(join(resourcesRoot, "dashboard")),
      agent: summarizePath(join(resourcesRoot, "agent")),
      skills: summarizePath(join(resourcesRoot, "skills")),
      lxeskill: summarizePath(join(resourcesRoot, "lxeskill")),
      config: summarizePath(join(resourcesRoot, "config")),
      branding: summarizePath(join(resourcesRoot, "branding")),
      wireguard: summarizePath(join(resourcesRoot, "wireguard")),
      legal: summarizePath(join(resourcesRoot, "legal")),
    },
    budgets: {
      runtime: budgetSummary(runtime, DESKTOP_RUNTIME_BUDGET_BYTES),
      unpacked: budgetSummary(total, DESKTOP_UNPACKED_BUDGET_BYTES),
    },
  };
};

export const assertDesktopResourceSizeBudgets = (report: DesktopResourceSizeReport): void => {
  const failures = Object.entries(report.budgets)
    .filter(([, budget]) => !budget.passed)
    .map(([name, budget]) => `${name} is ${budget.mib} MiB; limit is ${budget.limit_mib} MiB`);
  const playwrightDriverNode = report.resources.runtime.python.playwright_driver_node;
  if (playwrightDriverNode.files > 0) {
    failures.push(
      `Playwright driver contains a duplicate Node runtime (${playwrightDriverNode.mib} MiB)`,
    );
  }
  const tools = report.resources.runtime.tools;
  if (tools.exiftool_executable.files !== 1 || tools.exiftool_support.files === 0) {
    failures.push("ExifTool executable or exiftool_files support directory is missing");
  }
  if (failures.length > 0) {
    throw new Error(`Desktop size budget exceeded: ${failures.join("; ")}`);
  }
};

export const writeDesktopResourceSizeReport = (
  unpackedRoot: string,
  outputPath: string,
): DesktopResourceSizeReport => {
  const report = createDesktopResourceSizeReport(unpackedRoot);
  const destination = resolve(outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  assertDesktopResourceSizeBudgets(report);
  return report;
};

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const unpackedRoot = resolve(process.argv[2] ?? join(repositoryRoot, "dist", "desktop", "win-unpacked"));
  const outputPath = resolve(
    process.argv[3] ?? join(repositoryRoot, "dist", "desktop", "desktop-resource-sizes.json"),
  );
  const report = writeDesktopResourceSizeReport(unpackedRoot, outputPath);
  console.log(
    `Desktop unpacked size: ${report.total.mib} MiB; runtime: ${report.resources.runtime.total.mib} MiB`,
  );
  console.log(`Desktop resource size report: ${outputPath}`);
}
