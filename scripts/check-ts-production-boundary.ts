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
requireText("apps/gateway/src/production.ts", /new TypeScriptAgentRuntime/, "production must assemble the TypeScript Runtime");
requireText("apps/gateway/src/production.ts", /py_tools\.bridge/, "Python execution must cross the one-shot py_tools bridge");

forbidPath("main.py", "the legacy Python production entrypoint must be deleted");
forbidPath("gateway", "the legacy Python Gateway must be deleted");
forbidPath("agent_runtime", "the legacy Python Runtime must be deleted");
forbidPath("apps/gateway/src/gateway-composition.ts", "the worker Gateway composition must be deleted");
forbidPath("apps/gateway/src/worker-client.ts", "the worker client must be deleted");
forbidPath("apps/gateway/src/worker-process.ts", "the worker process launcher must be deleted");
forbidPath("apps/gateway/src/worker-supervisor.ts", "the worker supervisor must be deleted");
forbidPath("packages/protocol/schemas/worker-envelope.schema.json", "the worker envelope contract must be deleted");
forbidText("apps/gateway/src/production.ts", /spawnWorker|WorkerProcess|createGatewayComposition/, "production must not retain a worker fallback");
forbidText("packages/protocol/src/types.ts", /WorkerEnvelope/, "protocol types must not expose a worker envelope");
forbidText("scripts/doctor.ps1", /platforms\.feishu|shared\.llm|agent_runtime|main\.py/, "doctor must not inspect deleted Python production modules");
requireText("scripts/doctor.ps1", /check-runtime-config\.ts/, "doctor must inspect Bun-owned Feishu and LLM configuration");

const pythonImports = /(?:^|\n)\s*(?:from|import)\s+(?:gateway|agent_runtime)(?:\.|\s|$)/m;
for await (const path of new Bun.Glob("**/*.py").scan({ cwd: root, onlyFiles: true })) {
  if (path.includes(".venv/") || path.includes(".venv\\")) continue;
  if (pythonImports.test(read(path))) failures.push(`${path}: retained Python must not import gateway or agent_runtime`);
}

const scriptCatalog = JSON.parse(read("py_tools/catalog.json")) as {
  protocol_version?: string;
  entries?: Array<{ name?: string; exposed?: boolean; owner_skills?: string[] }>;
};
if (scriptCatalog.protocol_version !== "1") failures.push("py_tools/catalog.json: protocol_version must be 1");
const scriptEntries = new Map((scriptCatalog.entries ?? []).map((entry) => [String(entry.name ?? ""), entry]));
for await (const path of new Bun.Glob("skills/**/SKILL.md").scan({ cwd: root, onlyFiles: true })) {
  const source = read(path);
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const skillName = frontmatter.match(/^name:\s*([^\r\n#]+)/m)?.[1]?.trim() ?? "";
  const scriptBlock = frontmatter.match(/^script_tools:\s*\r?\n((?:\s+-[^\r\n]+\r?\n?)*)/m)?.[1] ?? "";
  const scriptTools = [...scriptBlock.matchAll(/^\s+-\s*([^\s#]+)/gm)].map((match) => match[1] ?? "").filter(Boolean);
  if (/\b(?:uv\s+run[^\r\n]*python|python(?:3)?\s+-m)\s+services\.agent_cli\b/i.test(source)) {
    failures.push(`${path}: active skill must use a registered script tool instead of shelling out to a business CLI`);
  }
  if (/services\.agent_cli\./.test(source)) failures.push(`${path}: active skill must not reference business module paths`);
  for (const toolName of scriptTools) {
    const entry = scriptEntries.get(toolName);
    if (!entry || entry.exposed === false) failures.push(`${path}: unknown or hidden script tool ${toolName}`);
    else if (!entry.owner_skills?.includes(skillName)) failures.push(`${path}: script tool ${toolName} does not declare owner skill ${skillName}`);
  }
}

const staleArchitectureDocs = /main\.py|agent_runtime|gateway\/[A-Za-z0-9_/-]+\.py|Python\s+(?:Gateway|Runtime|Dashboard|backend)/i;
for (const pattern of ["README.md", "web/**/*.md", "docs/harness/**/*.md", "docs/database/**/*.md"]) {
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
