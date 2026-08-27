import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLlmProviderCatalog } from "../src/llm-provider-catalog";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const provider = (name: string, patch: Record<string, unknown> = {}) => ({
  name,
  label: name.toUpperCase(),
  api_style: "openai-responses",
  base_url: `https://${name}.example.invalid/api/v1`,
  default_model: `${name}/model`,
  default_headers: {},
  aliases: [`${name}-alias`],
  models: {
    [`${name}/model`]: {
      context_window_tokens: 100_000,
      max_tokens: 8_192,
      supports_vision: true,
      supports_thinking: true,
      supports_temperature: true,
      thinking_request_style: "openai-effort",
      thinking_levels: ["minimal", "low", "medium", "high"],
      thinking_default: "medium",
    },
  },
  ...patch,
});

const catalogRoot = (...providers: Array<Record<string, unknown>>): string => {
  const root = mkdtempSync(join(tmpdir(), "lxe-llm-catalog-"));
  roots.push(root);
  mkdirSync(join(root, "providers"), { recursive: true });
  for (const spec of providers) {
    writeFileSync(join(root, "providers", `${String(spec.name)}.json`), JSON.stringify(spec));
  }
  writeFileSync(join(root, "auth-profiles.json"), JSON.stringify({
    profiles: Object.fromEntries(providers.map((spec) => [String(spec.name), {
      type: "api_key",
      env_names: [`${String(spec.name).toUpperCase()}_API_KEY`],
      required: true,
    }])),
  }));
  return root;
};

describe("LLM Provider Catalog", () => {
  test("discovers a third shipped provider without a code registration", () => {
    const root = catalogRoot(
      provider("one", { desktop_default: true }),
      provider("two"),
      provider("three"),
    );
    const catalog = loadLlmProviderCatalog(root);

    expect(catalog.defaultProvider).toBe("one");
    expect(catalog.providers.map((item) => item.name).sort()).toEqual(["one", "three", "two"]);
    expect(catalog.requireProvider("three-alias").name).toBe("three");
    expect(catalog.requireModel(catalog.requireProvider("three"), "three/model").supportsVision).toBeTrue();
  });

  test("allows the same model id under different providers", () => {
    const shared = provider("one").models;
    const root = catalogRoot(
      provider("one", { desktop_default: true }),
      provider("two", { default_model: "one/model", models: shared }),
    );
    const catalog = loadLlmProviderCatalog(root);
    expect(catalog.requireModel(catalog.requireProvider("one"), "one/model").id).toBe("one/model");
    expect(catalog.requireModel(catalog.requireProvider("two"), "one/model").id).toBe("one/model");
  });

  test("rejects conflicting names, defaults, API styles, and model defaults", () => {
    const aliases = catalogRoot(
      provider("one", { desktop_default: true, aliases: ["shared"] }),
      provider("two", { aliases: ["shared"] }),
    );
    expect(() => loadLlmProviderCatalog(aliases)).toThrow("duplicate LLM provider name or alias shared");

    const defaults = catalogRoot(
      provider("one", { desktop_default: true }),
      provider("two", { desktop_default: true }),
    );
    expect(() => loadLlmProviderCatalog(defaults)).toThrow("exactly one desktop_default provider; found 2");

    const style = catalogRoot(provider("one", { desktop_default: true, api_style: "unknown-wire" }));
    expect(() => loadLlmProviderCatalog(style)).toThrow("api_style is unsupported");

    const completions = loadLlmProviderCatalog(catalogRoot(provider("one", {
      desktop_default: true,
      api_style: "openai-completions",
    })));
    expect(completions.requireProvider("one").apiStyle).toBe("openai_completions");

    const model = catalogRoot(provider("one", { desktop_default: true, default_model: "retired/model" }));
    expect(() => loadLlmProviderCatalog(model)).toThrow("default_model is not present in models");
  });

  test("reports the malformed source file instead of silently skipping it", () => {
    const root = catalogRoot(provider("one", { desktop_default: true }));
    const path = join(root, "providers", "broken.json");
    writeFileSync(path, "{not-json");
    expect(() => loadLlmProviderCatalog(root)).toThrow(`invalid JSON in ${path}`);
  });
});
