import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { developmentSecretEnvironment, loadEnvironmentFiles, parseEnvFile } from "../../src/bootstrap/env";

describe("project environment", () => {
  test("keeps the first value across explicitly selected import files", () => {
    const files: Record<string, string> = {
      [join("/repo", ".env")]: "A=env\nB=env\nexport C='single value'\n",
      [join("/repo", ".env.local")]: "A=local\nB=local\nD=local\n",
      [join("/repo", "legacy.env")]: "A=legacy\nE=\"line\\nnext\"\n",
    };

    const result = loadEnvironmentFiles({
      paths: [join("/repo", ".env"), join("/repo", ".env.local"), join("/repo", "legacy.env")],
      initial: { A: "process" },
      readFile: (path) => files[path],
    });

    expect(result).toEqual({
      A: "process",
      B: "env",
      C: "single value",
      D: "local",
      E: "line\nnext",
    });
  });

  test("matches Python parsing for comments, export, names, and quotes", () => {
    expect(
      parseEnvFile(`
        # comment
        export GOOD_NAME = "tab\\tvalue"
        SINGLE='literal\\nvalue'
        1BAD=no
        BAD-NAME=no
        ___=no
        中文变量=ok
        ALSO_GOOD=value=with=equals
        ignored line
      `),
    ).toEqual([
      ["GOOD_NAME", "tab\tvalue"],
      ["SINGLE", "literal\\nvalue"],
      ["中文变量", "ok"],
      ["ALSO_GOOD", "value=with=equals"],
    ]);
  });

  test("allows only source-development secrets into the runtime overlay", () => {
    expect(developmentSecretEnvironment({
      KIMI_CODE_API_KEY: "secret",
      FEISHU_APP_SECRET: "feishu-secret",
      FEISHU_APP_ID: "must-come-from-settings",
      AGENT_LLM_PROVIDER: "must-come-from-settings",
      LXE_DATA_SERVER_URL: "must-come-from-settings",
    })).toEqual({
      KIMI_CODE_API_KEY: "secret",
      FEISHU_APP_SECRET: "feishu-secret",
    });
  });
});
