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
