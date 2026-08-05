import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../..");
const source = (path) => readFileSync(join(root, path), "utf8");

describe("local model authentication architecture", () => {
  test("settings owns local BYOK without restoring dotenv import", () => {
    const shell = source("apps/dashboard/src/desktop/shell.tsx");
    const desktopMain = source("apps/desktop/src/main.ts");
    const protocol = source("packages/foundation/desktop-protocol/src/index.ts");

    expect(shell).toContain("desktop.saveLocalModelCredential");
    expect(shell).toContain("setup.local_auth_path");
    expect(shell).toContain("t.desktop.base.plaintextWarning");
    expect(shell).not.toContain("selectConfigImport");
    expect(protocol).not.toContain("DesktopConfigImport");
    expect(protocol).not.toContain("selectConfigImport");
    expect(desktopMain).toContain("!credential && state.credential_source === \"local\"");
    expect(desktopMain).toContain("await gateway.restart()");
  });

  test("source dotenv cannot supply model credentials", () => {
    const environment = source("apps/gateway/src/bootstrap/env.ts");
    const template = source(".env.example");
    for (const variable of ["KIMI_CODE_API_KEY", "DEEPSEEK_API", "GLM_API_KEY"]) {
      expect(environment).not.toContain(`"${variable}"`);
      expect(template).not.toContain(variable);
    }
  });
});
