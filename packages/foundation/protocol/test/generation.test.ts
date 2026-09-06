import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGenerated, generatedFile, generateTypes, schemaFiles, useTypeAliases } from "../scripts/generate-types";

const directories: string[] = [];
async function fixtureDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "lxe-protocol-generation-"));
  directories.push(directory);
  for (const name of schemaFiles) {
    await copyFile(new URL(`../schemas/${name}`, import.meta.url), join(directory, name));
  }
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("generation is deterministic, independent of checkout path, and matches committed types", async () => {
  const expected = await generateTypes();
  await checkGenerated(expected);
  expect(await generateTypes(await fixtureDirectory())).toBe(expected);
  expect(expected).not.toMatch(/export interface|\bany\b/u);
  expect(expected).toContain("export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];");
});

test("check rejects missing and edited output without writing it", async () => {
  const directory = await fixtureDirectory();
  const output = join(directory, "output.ts");
  const expected = await generateTypes(directory);
  await expect(checkGenerated(expected, output)).rejects.toThrow("Missing generated");
  await expect(readFile(output)).rejects.toThrow();
  await writeFile(output, expected + "// edited\n");
  await expect(checkGenerated(expected, output)).rejects.toThrow("stale or edited");
  expect(await readFile(output, "utf8")).toBe(expected + "// edited\n");
});

test("even runtime-only schema changes invalidate the generated fingerprint", async () => {
  const directory = await fixtureDirectory();
  const path = join(directory, "agent-job.schema.json");
  const schema = JSON.parse(await readFile(path, "utf8"));
  schema.properties.job_id.minLength = 2;
  await writeFile(path, JSON.stringify(schema));
  await expect(checkGenerated(await generateTypes(directory), generatedFile)).rejects.toThrow("stale or edited");
});

test("missing schema inputs and references fail instead of producing partial output", async () => {
  const directory = await fixtureDirectory();
  await rm(join(directory, "common.schema.json"));
  await expect(generateTypes(directory)).rejects.toThrow();
  const empty = join(directory, "empty");
  await mkdir(empty);
  await expect(generateTypes(empty)).rejects.toThrow();
  await writeFile(join(directory, "common.schema.json"), "{}");
  await expect(generateTypes(directory)).rejects.toThrow();
});

test("alias conversion preserves object structure and refuses unsupported declarations", () => {
  expect(useTypeAliases("export interface Example {\n  nested: { value: string };\n}\n"))
    .toBe("export type Example = {\n  nested: { value: string };\n};\n");
  expect(() => useTypeAliases("export interface Example extends Other {\n}\n"))
    .toThrow("Unsupported generated interface");
});
