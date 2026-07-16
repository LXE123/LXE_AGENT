import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const failures: string[] = [];
const requireText = (path: string, pattern: RegExp, message: string): void => {
  if (!pattern.test(read(path))) failures.push(`${path}: ${message}`);
};
const forbidText = (path: string, pattern: RegExp, message: string): void => {
  if (pattern.test(read(path))) failures.push(`${path}: ${message}`);
};
const forbidPath = (path: string, message: string): void => {
  if (existsSync(join(root, path))) failures.push(`${path}: ${message}`);
};

forbidText("package.json", /main\.py|agent_runtime\.worker/, "workspace scripts must not start Python production code");
forbidText("package.json", /gateway:(?:dev|watch|start|stop|build)/, "workspace must not expose a standalone Gateway CLI");
forbidText("apps/gateway/package.json", /"(?:dev|watch|start|stop|build)"\s*:/, "Gateway package must be a desktop library only");
forbidText("config/runtime.env", /AGENT_DASHBOARD_(?:ENABLED|HOST|PORT|PORT_AUTO_FALLBACK|OPEN_BROWSER)/, "runtime must not expose browser Dashboard settings");
forbidText("apps/dashboard/src/api/client.ts", /\bfetch\b|VITE_API_BASE_URL|HttpDashboardTransport/, "Renderer API must use Electron IPC only");
requireText("apps/desktop/src/main.ts", /registerDashboardProtocol/, "packaged Renderer must load through the Electron app protocol");
requireText("package.json", /"desktop:preview"\s*:\s*"bun run dashboard:build && bun run --cwd apps\/desktop preview"/, "workspace must expose the production Renderer preview");
requireText("apps/desktop/package.json", /"preview"\s*:\s*"bun run build && bun src\/preview\.ts"/, "desktop package must build Main and Preload before preview");
requireText("apps/desktop/src/preview.ts", /LXE_DESKTOP_PREVIEW\s*=\s*"1"/, "preview launcher must select the internal preview mode");
requireText("apps/desktop/src/preview.ts", /delete environment\.LXE_DATA_ROOT/, "preview launcher must discard external desktop data roots");
forbidText("apps/desktop/src/preview.ts", /https?:\/\/|\bfetch\b|VITE|5173|8765|LXE_DASHBOARD_DEV_URL\s*=/, "production preview must not start or target an HTTP Renderer");
requireText("apps/desktop/src/main.ts", /usesProductionRenderer\(launchMode\)/, "desktop must select the Renderer independently from packaging");
requireText("apps/desktop/src/main.ts", /usesPackagedRuntime\(launchMode\)/, "desktop must keep preview on the source Runtime");
requireText("scripts/install.sh", /REF="lxe-agent-TUI"/, "legacy shell installer must forward to the TUI product line");
requireText("scripts/install.ps1", /\$Ref\s*=\s*"lxe-agent-TUI"/, "legacy PowerShell installer must forward to the TUI product line");
forbidText("config/runtime.env", /LXE_SCRIPT_TOOL_BRIDGE_ENABLED/, "runtime configuration must not restore the retired bridge gate");

forbidPath("main.py", "the legacy Python production entrypoint must be deleted");
for (const path of [
  "agent_runtime",
  "browser_auth_service",
  "clients",
  "gateway",
  "lxeskill",
  "platforms",
  "services",
  "shared",
  "tests",
]) {
  forbidPath(path, "legacy top-level Python directory must be deleted");
}
forbidPath("apps/gateway/src/orchestration/gateway-composition.ts", "the worker Gateway composition must be deleted");
forbidPath("apps/gateway/src/orchestration/worker-client.ts", "the worker client must be deleted");
forbidPath("apps/gateway/src/orchestration/worker-process.ts", "the worker process launcher must be deleted");
forbidPath("apps/gateway/src/orchestration/worker-supervisor.ts", "the worker supervisor must be deleted");
forbidPath("apps/gateway/src/main.ts", "the standalone Gateway CLI must be deleted");
forbidPath("apps/gateway/src/bootstrap/cli.ts", "the standalone Gateway bootstrap must be deleted");
forbidPath("apps/gateway/src/orchestration/production.ts", "the standalone Gateway production assembly must be deleted");
forbidPath("apps/gateway/src/dashboard/server.ts", "the browser Dashboard HTTP server must be deleted");
forbidPath("apps/gateway/src/dashboard/browser.ts", "the browser Dashboard opener must be deleted");
forbidPath("packages/foundation/protocol/schemas/worker-envelope.schema.json", "the worker envelope contract must be deleted");
forbidPath("packages/agent/runtime/src/tooling/script-tools.ts", "the retired script-tool runner must be deleted");
forbidPath("python/lxeskill_cli/lxeskill/bridge.py", "the retired Python bridge entrypoint must be deleted");
forbidText("packages/foundation/protocol/src/types.ts", /WorkerEnvelope/, "protocol types must not expose a worker envelope");

const pythonImports = /(?:^|\n)\s*(?:from|import)\s+(?:gateway|agent_runtime)(?:\.|\s|$)/m;
for await (const path of new Bun.Glob("**/*.py").scan({ cwd: root, onlyFiles: true })) {
  if (path.includes(".venv/") || path.includes(".venv\\")) continue;
  if (pythonImports.test(read(path))) failures.push(`${path}: retained Python must not import gateway or agent_runtime`);
}

const scriptCatalogPath = "python/lxeskill_cli/lxeskill/catalog.json";
const scriptCatalog = JSON.parse(read(scriptCatalogPath)) as {
  protocol_version?: string;
  entries?: Array<{
    name?: string;
    exposed?: boolean;
    owner_skills?: string[];
    command_path?: string[];
    visibility?: string;
  }>;
};
if (scriptCatalog.protocol_version !== "1") failures.push(`${scriptCatalogPath}: protocol_version must be 1`);
const commandEntries = new Map((scriptCatalog.entries ?? []).map((entry) => [
  `lxeskill ${(entry.command_path ?? []).map(String).join(" ")}`.trim(),
  entry,
]));
const declaredCommands = new Map<string, string>();
for await (const path of new Bun.Glob("skills/**/SKILL.md").scan({ cwd: root, onlyFiles: true })) {
  const source = read(path);
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const skillName = frontmatter.match(/^name:\s*([^\r\n#]+)/m)?.[1]?.trim() ?? "";
  if (/^script_tools:/m.test(frontmatter)) failures.push(`${path}: script_tools metadata is retired; use commands`);
  const commandBlock = frontmatter.match(/^commands:\s*\r?\n((?:\s+-[^\r\n]+\r?\n?)*)/m)?.[1] ?? "";
  const commands = [...commandBlock.matchAll(/^\s+-\s*([^#\r\n]+?)\s*$/gm)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  if (/\b(?:uv\s+run[^\r\n]*python|python(?:3)?\s+-m)\s+services\.agent_cli\b/i.test(source)) {
    failures.push(`${path}: active skill must use lxeskill instead of shelling out to a business Python module`);
  }
  if (/services\.agent_cli\./.test(source)) failures.push(`${path}: active skill must not reference business module paths`);
  for (const command of commands.filter((value) => value.startsWith("lxeskill "))) {
    const entry = commandEntries.get(command);
    if (!entry || !["business", "browser"].includes(String(entry.visibility ?? ""))) {
      failures.push(`${path}: unknown or non-business lxeskill command ${command}`);
      continue;
    }
    const canonicalOwner = entry.owner_skills?.[0] ?? "";
    if (canonicalOwner !== skillName) {
      failures.push(`${path}: lxeskill command ${command} is canonically owned by ${canonicalOwner || "nobody"}`);
    }
    const existingOwner = declaredCommands.get(command);
    if (existingOwner && existingOwner !== skillName) {
      failures.push(`${path}: duplicate lxeskill command ownership ${command}: ${existingOwner}, ${skillName}`);
    }
    declaredCommands.set(command, skillName);
  }
}
for (const [command, entry] of commandEntries) {
  if (!["business", "browser"].includes(String(entry.visibility ?? ""))) continue;
  const canonicalOwner = entry.owner_skills?.[0] ?? "";
  if (!canonicalOwner) failures.push(`${scriptCatalogPath}: ${command} has no canonical owner skill`);
  else if (declaredCommands.get(command) !== canonicalOwner) {
    failures.push(`${scriptCatalogPath}: ${command} is missing from canonical owner skill ${canonicalOwner}`);
  }
}

const staleArchitectureDocs = /main\.py|agent_runtime|gateway\/[A-Za-z0-9_/-]+\.py|Python\s+(?:Gateway|Runtime|Dashboard|backend)/i;
for (const pattern of ["README.md", "apps/dashboard/**/*.md", "docs/harness/**/*.md", "docs/database/**/*.md"]) {
  for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
    if (staleArchitectureDocs.test(read(path))) {
      failures.push(`${path}: documentation must describe the Bun-only production architecture`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log("TypeScript production boundary OK");
