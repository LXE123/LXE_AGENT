import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboardRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(dashboardRoot, "..", "..");
const fontPath = resolve(dashboardRoot, "src", "assets", "fonts", "HarmonyOS_Sans_SC.ttf");
const licensePath = resolve(dashboardRoot, "public", "legal", "HarmonyOS-Sans-LICENSE.txt");

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

describe("HarmonyOS Sans Dashboard assets", () => {
  test("keeps the official font and license byte-for-byte intact", () => {
    expect(sha256(readFileSync(fontPath)))
      .toBe("8978e05044e7089ad6a9de38c505c8148305607983487435a916d2610700a7ca");
    expect(sha256(readFileSync(licensePath)))
      .toBe("7d7acf8e3ac928ae7f34aaa9f8e348dd0476dbb52caaa058e402894d4f6efe73");
  });

  test("declares the variable font globally and publishes its required notice", () => {
    const styles = readFileSync(resolve(dashboardRoot, "src", "styles.css"), "utf8");
    const notices = readFileSync(resolve(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");

    expect(styles).toContain('font-family: "HarmonyOS Sans SC";');
    expect(styles).toContain("font-weight: 100 900;");
    expect(styles).toContain("font-family: var(--font-sans);");
    expect(notices).toContain("LXE Agent uses an unmodified copy of HarmonyOS Sans SC");
    expect(notices).toContain("legal/HarmonyOS-Sans-LICENSE.txt");
  });
});
