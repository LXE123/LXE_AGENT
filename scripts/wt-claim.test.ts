import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("wt-claim shell entrypoint", () => {
  test("keeps the extensionless Bash script on LF checkouts", () => {
    const attributes = readFileSync(resolve(repositoryRoot, ".gitattributes"), "utf8");
    const script = readFileSync(resolve(repositoryRoot, "scripts", "wt-claim"), "utf8");

    expect(attributes).toContain("scripts/wt-claim text eol=lf");
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).not.toContain("\r");
    expect(script).toContain("set -euo pipefail\n");
  });

  test("provides a native Windows PowerShell entrypoint", () => {
    const script = readFileSync(resolve(repositoryRoot, "scripts", "wt-claim.ps1"), "utf8");

    expect(script).toContain('if ($Command -eq "status")');
    expect(script).toContain('if ($Command -eq "release")');
    expect(script).toContain('"codex/$slug"');
    expect(script).toContain("bun install --frozen-lockfile");
    expect(script).toContain("uv sync --frozen");
  });
});
