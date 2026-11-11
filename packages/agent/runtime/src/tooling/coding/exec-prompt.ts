/**
 * The exec tool description is generated from the shell that was actually resolved
 * on this host, not from a fixed string covering every platform at once. The rules
 * genuinely differ: Windows PowerShell 5.1 rejects `&&` at parse time, so a shared
 * description either misleads that host or wastes tokens on the others.
 */

import type { ExecShellProfile } from "../exec-shell";

export interface ExecPromptLimits {
  /** Bytes of output returned inline before the rest moves to the transcript file. */
  maxOutputBytes: number;
}

const isWindows = (profile: ExecShellProfile): boolean => profile.kind !== "posix";

const shellLine = (profile: ExecShellProfile): string => {
  if (profile.kind === "posix") {
    return "Commands run through `/bin/sh -c`, without loading user profiles.";
  }
  if (profile.kind === "pwsh") {
    return `Commands run through PowerShell ${profile.major ?? 7} (pwsh) with -NoProfile -NonInteractive.`;
  }
  return "Commands run through Windows PowerShell 5.1 with -NoProfile -NonInteractive.";
};

const chainingLine = (profile: ExecShellProfile): string => {
  if (profile.kind === "windows-powershell") {
    return "This shell does NOT support `&&` or `||`: they are parse errors, so the whole command fails before anything runs. Chain dependent commands as `cmd1; if ($?) { cmd2 }`, and use `;` when you do not care whether the earlier command failed.";
  }
  if (profile.kind === "pwsh") {
    return "Chain dependent commands with `&&` or `||` in one call; use `;` when you do not care whether the earlier command failed.";
  }
  return "Chain dependent commands with `&&` or `||` in one call; use `;` when you do not care whether the earlier command failed.";
};

const quotingLines = (profile: ExecShellProfile): string[] => {
  if (profile.kind === "posix") {
    return ["Quote paths containing spaces: `python \"/path/with spaces/script.py\"`."];
  }
  return [
    "Quote paths containing spaces, and invoke an executable whose path has spaces through the call operator: `& \"C:\\Program Files\\App\\tool.exe\" --flag`. Without `&` the path is parsed as a string and never runs.",
  ];
};

const truncationLine = (profile: ExecShellProfile, limits: ExecPromptLimits): string => {
  const selfTruncation = isWindows(profile)
    ? "`Select-Object -First`, `Select-Object -Last`"
    : "`head`, `tail`";
  return `Output over ${limits.maxOutputBytes} bytes keeps its END inline and writes captured output to a bounded file returned as output_path. max-output-tokens can request a smaller model-visible observation; when that omits output, a recovery file is created even below the byte threshold. For a running command the file only covers output captured so far. Check status, output_file_covers_captured, output_file_truncated, and output_incomplete before treating a terminal file as complete. Do NOT pipe through ${selfTruncation} or similar to shrink output: that discards the data before it can be captured. Search the saved file with exec or use read with offset/limit.`;
};

export function execToolDescription(profile: ExecShellProfile, limits: ExecPromptLimits): string {
  return [
    "Execute a non-interactive shell command. If it outlives yield-time-ms, it keeps running under this chat and exec returns an exec_id for wait.",
    shellLine(profile),
    "Commands follow the current environment permission mode for local file writes. Changing cwd does not expand the fixed workspace boundary. This policy does not restrict networking.",
    "",
    "Environment: python and pip use the configured interpreter or this project's .venv. External commands are resolved through PATH.",
    "Use the cwd parameter for the working directory instead of cd.",
    "",
    chainingLine(profile),
    ...quotingLines(profile),
    isWindows(profile)
      ? "Use exec to list directories and search files with Get-ChildItem and Select-String."
      : "Use exec to list directories and search files with ls, find, and rg (or grep when rg is unavailable).",
    "Use read to inspect a file, edit to change existing text, and write to create or replace a file.",
    truncationLine(profile, limits),
    "Use wait with the returned exec_id to observe new output or terminate a running command. Finishing does not automatically wake the model.",
    "",
  ].join("\n");
}

export function execCommandParameterDescription(_profile: ExecShellProfile): string {
  return "Shell command string. Use cwd for the working directory.";
}
