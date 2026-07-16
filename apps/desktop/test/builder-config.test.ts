import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  desktopBuilderConfigPath,
  validateDesktopBuilderConfig,
} from "../scripts/validate-builder-config";

const temporaryRoots: string[] = [];
const validatorPath = join(import.meta.dir, "..", "scripts", "validate-builder-config.ts");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("electron-builder configuration", () => {
  test("matches the schema bundled with the pinned electron-builder", async () => {
    await expect(validateDesktopBuilderConfig()).resolves.toBeUndefined();
  });

  test("exits nonzero and identifies an unknown Windows option", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-builder-config-"));
    temporaryRoots.push(root);

    const sourceConfig = readFileSync(desktopBuilderConfigPath, "utf8");
    const invalidConfig = sourceConfig.replace(
      /^win:(\r?\n)/mu,
      (_match, lineEnding: string) => [
        "win:",
        "  signingHashAlgorithms:",
        "    - sha256",
        "",
      ].join(lineEnding),
    );
    if (invalidConfig === sourceConfig) throw new Error("Windows builder configuration block was not found");
    const invalidConfigPath = join(root, "electron-builder.yml");
    writeFileSync(invalidConfigPath, invalidConfig, "utf8");

    const result = Bun.spawnSync({
      cmd: [process.execPath, validatorPath, invalidConfigPath],
      timeout: 20_000,
      killSignal: "SIGKILL",
    });

    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "configuration.win has an unknown property 'signingHashAlgorithms'",
    );
  }, 30_000);
});
