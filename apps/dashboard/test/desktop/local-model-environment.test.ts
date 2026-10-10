import { expect, test } from "bun:test";
import { developmentSecretEnvironment, parseEnvFile } from "../../../gateway/src/bootstrap/env";

test("development dotenv forwards integration secrets but cannot provision local model credentials", () => {
  const input = Object.fromEntries(parseEnvFile(`
    FEISHU_APP_SECRET=fixture-integration-secret
    KIMI_CODE_API_KEY=fixture-kimi-key
    DEEPSEEK_API=fixture-deepseek-key
    GLM_API_KEY=fixture-glm-key
  `));
  expect(developmentSecretEnvironment(input)).toEqual({ FEISHU_APP_SECRET: "fixture-integration-secret" });
});

test("the published dotenv template contains no local model credential assignments", async () => {
  const names = new Set(parseEnvFile(await Bun.file(new URL("../../../../.env.example", import.meta.url)).text()).map(([name]) => name));
  expect(names.size).toBeGreaterThan(0);
  for (const name of ["KIMI_CODE_API_KEY", "DEEPSEEK_API", "GLM_API_KEY"]) expect(names.has(name)).toBe(false);
});
