import { describe, expect, test } from "bun:test";
import {
  execCommandParameterDescription,
  execToolDescription,
  type ExecPromptLimits,
} from "../../src/tooling/coding/exec-prompt";
import type { ExecShellProfile } from "../../src/tooling/exec-shell";

const LIMITS: ExecPromptLimits = {
  maxOutputBytes: 50_000,
};

const posix: ExecShellProfile = { kind: "posix" };
const pwsh: ExecShellProfile = { kind: "pwsh", major: 7 };
const windowsPowerShell: ExecShellProfile = { kind: "windows-powershell", major: 5 };

describe("exec tool description", () => {
  test("documents only the shell this host actually runs", () => {
    const unix = execToolDescription(posix, LIMITS);
    expect(unix).toContain("/bin/sh -c");
    expect(unix).not.toContain("PowerShell");
    expect(unix).not.toContain("Get-ChildItem");

    const seven = execToolDescription(pwsh, LIMITS);
    expect(seven).toContain("PowerShell 7 (pwsh)");
    expect(seven).not.toContain("/bin/sh");
  });

  test("warns that Windows PowerShell 5.1 cannot parse && or ||", () => {
    const legacy = execToolDescription(windowsPowerShell, LIMITS);
    expect(legacy).toContain("does NOT support `&&` or `||`");
    expect(legacy).toContain("cmd1; if ($?) { cmd2 }");
    expect(legacy).toContain("Windows PowerShell 5.1");

    // The 7+ description must not carry the 5.1 warning, or the model needlessly
    // avoids an operator that works there.
    const seven = execToolDescription(pwsh, LIMITS);
    expect(seven).not.toContain("does NOT support");
    expect(seven).toContain("Chain dependent commands with `&&`");
  });

  test("tells the model that oversized output is captured instead of lost", () => {
    for (const profile of [posix, pwsh, windowsPowerShell]) {
      const description = execToolDescription(profile, LIMITS);
      expect(description).toContain("50000 bytes");
      expect(description).toContain("output_path");
      expect(description).toContain("max-output-tokens");
      expect(description).toContain("output_file_covers_captured");
      expect(description).not.toContain("complete transcript");
      expect(description).toMatch(/Do NOT pipe through/u);
    }
    // The self-truncation the model would reach for differs per shell.
    expect(execToolDescription(posix, LIMITS)).toContain("`head`, `tail`");
    expect(execToolDescription(pwsh, LIMITS)).toContain("Select-Object -First");
  });

  test("routes file work to the dedicated tools using this shell's vocabulary", () => {
    expect(execToolDescription(posix, LIMITS)).toContain("the grep tool instead of shell `grep`");
    expect(execToolDescription(pwsh, LIMITS)).toContain("the grep tool instead of `Select-String`");
    expect(execToolDescription(windowsPowerShell, LIMITS)).toContain("the read tool instead of `Get-Content`");
  });

  test("does not tell the model to inspect directories with a shell it just banned", () => {
    for (const profile of [posix, pwsh, windowsPowerShell]) {
      const description = execToolDescription(profile, LIMITS);
      expect(description).not.toContain("Check a directory");
      expect(description).not.toContain("Test-Path");
    }
  });

  test("keeps the lxeskill single-command rule on every shell", () => {
    for (const profile of [posix, pwsh, windowsPowerShell]) {
      expect(execToolDescription(profile, LIMITS)).toContain("must be the only command");
      expect(execCommandParameterDescription(profile)).toContain("exactly one standalone");
    }
  });

  test("documents session-owned wait without model wakeups", () => {
    const description = execToolDescription(posix, LIMITS);
    expect(description).toContain("exec_id for wait");
    expect(description).toContain("does not automatically wake the model");
  });

  test("drops && from the lxeskill operator list where it cannot be typed anyway", () => {
    expect(execCommandParameterDescription(posix)).toContain("&&");
    expect(execCommandParameterDescription(windowsPowerShell)).not.toContain("&&");
  });
});
