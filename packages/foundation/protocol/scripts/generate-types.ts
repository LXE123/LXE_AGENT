import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compile } from "json-schema-to-typescript";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const schemaFiles = [
  "agent-job.schema.json",
  "emit-request.schema.json",
  "desktop-stream-batch.schema.json",
  "common.schema.json",
] as const;
export const generatedFile = resolve(packageRoot, "src/generated/contracts.ts");

export function useTypeAliases(source: string): string {
  // The published generator emits object interfaces. Convert only its plain, top-level
  // declarations; fail on new syntax rather than silently adding JSON index signatures.
  const result = source.replace(/^export interface (\w+) \{\n([\s\S]*?)^\}/gm,
    "export type $1 = {\n$2};");
  if (/^export interface /m.test(result)) throw new Error("Unsupported generated interface declaration");
  return result;
}

export async function generateTypes(schemaDirectory = resolve(packageRoot, "schemas")): Promise<string> {
  // Read the exact manifest first: missing inputs must fail, never silently scan zero files.
  const hash = createHash("sha256");
  for (const name of schemaFiles) {
    const source = await readFile(resolve(schemaDirectory, name), "utf8");
    JSON.parse(source);
    hash.update(name).update("\0").update(source).update("\0");
  }
  return useTypeAliases(await compile({
    title: "ProtocolContracts",
    anyOf: schemaFiles.slice(0, 3).map((name) => ({ $ref: name })),
  }, "ProtocolContracts", {
    cwd: schemaDirectory,
    additionalProperties: false,
    ignoreMinAndMaxItems: true,
    unknownAny: true,
    bannerComment: `/** Generated from protocol/schemas. DO NOT EDIT. Run bun run protocol:generate.\n * Schema SHA-256: ${hash.digest("hex")}\n */`,
    style: { singleQuote: false, semi: true, tabWidth: 2, trailingComma: "all", printWidth: 100 },
    $refOptions: { resolve: { http: false } },
  }));
}

export async function checkGenerated(expected: string, path = generatedFile): Promise<void> {
  let actual: string;
  try {
    actual = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    throw new Error(`Missing generated protocol types: ${path}. Run bun run protocol:generate.`);
  }
  if (actual !== expected) throw new Error("Generated protocol types are stale or edited. Run bun run protocol:generate.");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: generate-types.ts [--check]");
  }
  const generated = await generateTypes();
  if (args[0] === "--check") {
    await checkGenerated(generated);
    console.log(`Protocol types match ${schemaFiles.length} schema files.`);
  } else {
    await mkdir(dirname(generatedFile), { recursive: true });
    await writeFile(generatedFile, generated);
    console.log(`Generated protocol types from ${schemaFiles.length} schema files.`);
  }
}
