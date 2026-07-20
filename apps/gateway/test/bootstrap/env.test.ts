import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadProjectEnv, parseEnvFile } from "../../src/bootstrap/env";

describe("project environment", () => {
  test("keeps the first value across process, .env, local, and runtime layers", () => {
    const files: Record<string, string> = {
      [join("/repo", ".env")]: "A=env\nB=env\nexport C='single value'\n",
      [join("/repo", ".env.local")]: "A=local\nB=local\nD=local\n",
      [join("/repo", "config", "runtime.env")]: "A=runtime\nE=\"line\\nnext\"\n",
    };

    const result = loadProjectEnv({
      projectRoot: "/repo",
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
});
