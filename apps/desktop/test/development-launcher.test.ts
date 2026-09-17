import { readFileSync } from "node:fs";

const developmentLauncher = readFileSync(new URL("../src/dev.ts", import.meta.url), "utf8");
const previewLauncher = readFileSync(new URL("../src/preview.ts", import.meta.url), "utf8");

describe("desktop development launchers", () => {
  test("use the current Bun executable for child commands on Windows", () => {
    expect(developmentLauncher).toContain('Bun.spawn([process.execPath, "run", "--cwd", "apps/dashboard", "dev"]');
    expect(developmentLauncher).toContain('Bun.spawn([process.execPath, "x", "electron", "."]');
    expect(previewLauncher).toContain('Bun.spawn([process.execPath, "x", "electron", "."]');
  });
});
