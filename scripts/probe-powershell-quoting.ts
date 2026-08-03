/**
 * Windows-only probe: does passing a command through `-Command` survive the trip
 * from Bun's argv array into powershell.exe intact?
 *
 * On Windows there is no argv at the OS level, only a single command-line string,
 * so Bun has to escape the array into one. If Bun's escaping rules and the ones
 * powershell.exe uses for `-Command` disagree, the shell silently runs a slightly
 * different script instead of reporting a quoting error.
 *
 * Each case is run twice through the real ExecShellAdapter.spawnSpec() body: once
 * as it ships today (`-Command`), and once as base64 UTF-16LE (`-EncodedCommand`).
 * Base64 contains no quotes, spaces or backslashes, so nothing can mangle it in
 * transit — it is the ground truth. Any difference between the two is transit
 * corruption, not a PowerShell syntax problem.
 *
 * Run from the repository root:  bun scripts/probe-powershell-quoting.ts
 */
import { ExecShellAdapter, resolveWindowsPowerShell } from "../packages/agent/runtime/src/tooling/exec-shell";

interface ProbeCase {
  name: string;
  command: string;
  /** What a correctly delivered script prints, for cases with a knowable answer. */
  expected?: string;
}

const CASES: ProbeCase[] = [
  { name: "single quotes", command: `Write-Output 'plain text'`, expected: "plain text" },
  { name: "double quotes", command: `Write-Output "double quoted"`, expected: "double quoted" },
  {
    name: "doubled quotes inside a string",
    command: `Write-Output "he said ""hi"" loudly"`,
    expected: `he said "hi" loudly`,
  },
  {
    name: "json payload",
    command: `Write-Output '{"key":"value","list":[1,2]}'`,
    expected: `{"key":"value","list":[1,2]}`,
  },
  {
    name: "backslash path",
    command: `Write-Output 'C:\\Program Files\\App\\bin'`,
    expected: `C:\\Program Files\\App\\bin`,
  },
  {
    name: "quote adjacent to backslash",
    command: `Write-Output "dir=""C:\\tmp\\"" end"`,
    expected: `dir="C:\\tmp\\" end`,
  },
  { name: "non-ascii", command: `Write-Output "中文 测试 ✓"`, expected: "中文 测试 ✓" },
  {
    name: "python -c with nested quotes",
    command: `python -c "import json; print(json.dumps({'k': 'v'}))"`,
    expected: `{"k": "v"}`,
  },
  {
    name: "git-style commit message",
    command: `Write-Output "fix: handle ""quoted"" input & $env:USERNAME"`,
  },
  {
    name: "caret and percent",
    command: `Write-Output "100%% ^caret& pipe|bar"`,
  },
];

const decode = (value: Uint8Array | undefined): string =>
  value ? new TextDecoder().decode(value).replace(/\r\n/gu, "\n").trim() : "";

const run = (argv: string[]): { stdout: string; stderr: string; code: number | null } => {
  const result = Bun.spawnSync(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  return { stdout: decode(result.stdout), stderr: decode(result.stderr), code: result.exitCode };
};

if (process.platform !== "win32") {
  console.error("This probe only means anything on Windows; nothing to do on " + process.platform + ".");
  process.exit(2);
}

const shell = resolveWindowsPowerShell({});
const versionProbe = run([shell, "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
console.log(`shell:   ${shell}`);
console.log(`version: ${versionProbe.stdout || "(unknown)"}`);
console.log(`bun:     ${Bun.version}`);
console.log("");

const adapter = new ExecShellAdapter();
let mismatches = 0;
let wrongResults = 0;

for (const probe of CASES) {
  // The production path, exactly as exec runs it today.
  const direct = adapter.spawnSpec(probe.command);
  // The same script body, delivered in a form nothing can corrupt in transit.
  const body = direct.argv[4] ?? "";
  const encoded = Buffer.from(body, "utf16le").toString("base64");
  const viaCommand = run(direct.argv);
  const viaEncoded = run([shell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);

  const transitDiffers = viaCommand.stdout !== viaEncoded.stdout || viaCommand.code !== viaEncoded.code;
  const expectedMiss = probe.expected !== undefined && viaEncoded.stdout !== probe.expected;
  if (transitDiffers) mismatches += 1;
  if (expectedMiss) wrongResults += 1;

  const verdict = transitDiffers ? "DIFFERS" : "same";
  console.log(`[${verdict}] ${probe.name}`);
  console.log(`   command:      ${probe.command}`);
  console.log(`   -Command:        exit=${viaCommand.code} stdout=${JSON.stringify(viaCommand.stdout)}`);
  console.log(`   -EncodedCommand: exit=${viaEncoded.code} stdout=${JSON.stringify(viaEncoded.stdout)}`);
  if (probe.expected !== undefined) {
    console.log(`   expected:        ${JSON.stringify(probe.expected)}`);
  }
  if (viaCommand.stderr) console.log(`   -Command stderr: ${JSON.stringify(viaCommand.stderr.slice(0, 200))}`);
  console.log("");
}

console.log("========================================");
console.log(`cases: ${CASES.length}   transit differences: ${mismatches}   unexpected results: ${wrongResults}`);
if (mismatches > 0) {
  console.log("");
  console.log("VERDICT: -Command corrupts at least one command in transit on this host.");
  console.log("Switching spawnSpec to -EncodedCommand is a real fix, not a precaution.");
} else {
  console.log("");
  console.log("VERDICT: no transit corruption observed on this host/Bun/PowerShell combination.");
  console.log("-EncodedCommand would be defensive only; the current -Command path holds for these cases.");
}
process.exit(0);
