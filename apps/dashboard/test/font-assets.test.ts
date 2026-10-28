import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboardRoot = resolve(import.meta.dir, "..");
const fontPath = resolve(dashboardRoot, "src", "assets", "fonts", "HarmonyOS_Sans_SC.ttf");

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

describe("HarmonyOS Sans Dashboard assets", () => {
  test("keeps the official font byte-for-byte intact", () => {
    expect(sha256(readFileSync(fontPath)))
      .toBe("8978e05044e7089ad6a9de38c505c8148305607983487435a916d2610700a7ca");
  });

  test("declares the variable font globally", () => {
    const styles = readFileSync(resolve(dashboardRoot, "src", "styles.css"), "utf8");

    expect(styles).toContain('font-family: "HarmonyOS Sans SC";');
    expect(styles).toContain("font-weight: 100 900;");
    expect(styles).toContain("font-family: var(--font-sans);");
  });
});
