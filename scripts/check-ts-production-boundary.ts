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

requireText("scripts/launcher.ps1", /run gateway:start/, "launcher must start the Bun Gateway");
requireText("scripts/launcher.ps1", /run gateway:stop/, "launcher must stop the Bun Gateway");
forbidText("scripts/launcher.ps1", /main\.py|agent_runtime\.worker|uv[^\r\n]*python/i, "launcher must not start Python production code");
requireText("scripts/install.sh", /run gateway:start/, "macOS launcher must start the Bun Gateway");
requireText("scripts/install.sh", /run gateway:stop/, "macOS launcher must stop the Bun Gateway");
forbidText("scripts/install.sh", /main\.py|agent_runtime\.worker/, "macOS launcher must not start Python production code");
forbidText("package.json", /main\.py|agent_runtime\.worker/, "workspace scripts must not start Python production code");
forbidText("apps/gateway/src/main.ts", /main\.py|agent_runtime\.worker/, "Bun CLI must not fall back to Python");
requireText("apps/gateway/src/orchestration/production.ts", /new TypeScriptAgentRuntime/, "production must assemble the TypeScript Runtime");
requireText("apps/gateway/src/orchestration/production.ts", /"-m",\s*"lxeskill"/, "business maintenance must cross the one-shot lxeskill CLI");
requireText("apps/gateway/src/orchestration/production.ts", /LXE_SCRIPT_TOOL_BRIDGE_ENABLED[\s\S]*?\?\?\s*"0"/, "the diagnostic script-tool bridge must default off");

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
forbidPath("packages/foundation/protocol/schemas/worker-envelope.schema.json", "the worker envelope contract must be deleted");
forbidText("apps/gateway/src/orchestration/production.ts", /spawnWorker|WorkerProcess|createGatewayComposition/, "production must not retain a worker fallback");
forbidText("packages/foundation/protocol/src/types.ts", /WorkerEnvelope/, "protocol types must not expose a worker envelope");
forbidText("scripts/doctor.ps1", /platforms\.feishu|shared\.llm|agent_runtime|main\.py/, "doctor must not inspect deleted Python production modules");
requireText("scripts/doctor.ps1", /bootstrap[\\/]runtime-config\.ts/, "doctor must inspect Bun-owned Feishu and LLM configuration");

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
