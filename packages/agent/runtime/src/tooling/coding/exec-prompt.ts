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
  return `Output over ${limits.maxOutputBytes} bytes keeps its END inline and writes captured output to a bounded file returned as output_path. max-output-tokens can request a smaller model-visible observation; when that omits output, a recovery file is created even below the byte threshold. For a running command the file only covers output captured so far. Check status, output_file_covers_captured, output_file_truncated, and output_incomplete before treating a terminal file as complete. Do NOT pipe through ${selfTruncation} or similar to shrink output: that discards the data before it can be captured. Read the transcript with grep, or read with offset/limit.`;
};

const fileToolLines = (profile: ExecShellProfile): string[] => {
  const replaced = isWindows(profile)
    ? {
      search: "`Get-ChildItem`",
      content: "`Select-String`",
      read: "`Get-Content`",
      write: "`Set-Content`/`Out-File`",
    }
    : {
      search: "shell `find`/`ls`",
      content: "shell `grep`",
      read: "`cat`/`head`/`tail`",
      write: "`echo >`/heredocs",
    };
  return [
    `Do not use exec for file work; the dedicated tools exist for it. Use the find and ls tools instead of ${replaced.search}, the grep tool instead of ${replaced.content}, the read tool instead of ${replaced.read}, and the write and edit tools instead of ${replaced.write}.`,
  ];
};

export function execToolDescription(profile: ExecShellProfile, limits: ExecPromptLimits): string {
  return [
    "Execute a non-interactive shell command. If it outlives yield-time-ms, it keeps running under this chat and exec returns an exec_id for wait.",
    shellLine(profile),
    "Commands inherit the local LXE Agent process permissions. There is no filesystem or network sandbox; the workspace is only the default working directory.",
    "",
    "Environment: python and pip resolve to this project's .venv; lxeskill prefers the precompiled project runtime and falls back to .venv in development.",
    "Use the cwd parameter for the working directory instead of cd.",
    "",
    chainingLine(profile),
    ...quotingLines(profile),
    ...fileToolLines(profile),
    truncationLine(profile, limits),
    "Use wait with the returned exec_id to observe new output or terminate a running command. Finishing does not automatically wake the model.",
    "",
    "A lxeskill invocation must be the only command in command: do not wrap it with uv, python -m, pipes, redirects, or shell operators.",
  ].join("\n");
}

export function execCommandParameterDescription(profile: ExecShellProfile): string {
  const operators = profile.kind === "windows-powershell"
    ? "newlines, pipes, redirects, semicolons, backticks, or $()"
    : "newlines, pipes, redirects, &&, ||, semicolons, backticks, or $()";
  return [
    "Shell command string.",
    `For lxeskill, provide exactly one standalone \`lxeskill <command> [options]\`; do not use uv, python -m, cd, ${operators}.`,
    "Use cwd for the working directory. Help/list/describe commands follow the same rule.",
  ].join(" ");
}
