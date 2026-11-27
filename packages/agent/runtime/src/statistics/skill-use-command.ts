import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { skillPathKey } from "../tooling/skill-files";

export type StatisticsShell = "posix" | "powershell";
type SkillMatch = { skill: string } | { command: string[] };

const posixShells = new Set(["bash", "sh", "zsh"]);
const powerShells = new Set(["pwsh", "powershell"]);
const pythonRunners = new Set(["py", "python", "python3"]);
const runners = new Set([...posixShells, ...powerShells, ...pythonRunners, "node", "deno", "ruby", "perl"]);
const scriptExtension = /\.(?:py|sh|js|ts|rb|pl|ps1|mjs|cjs|cmd|bat)$/iu;

function resolvePath(directory: string, operand: string, shell: StatisticsShell): string {
  const path = shell === "powershell" ? operand.replaceAll("\\", "/") : operand;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(directory, path);
}

// Tokenize words and connectors together so a quoted or escaped "|" stays an argument.
// Stop at unsupported shell constructs rather than inspecting their bodies as commands.
function* segments(command: string, shell: StatisticsShell): Generator<string[]> {
  const powershell = shell === "powershell";
  let args: string[] = [], word = "", quote = "", started = false;
  let groupDepth = 0;
  const endWord = () => {
    if (started) args.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!, next = command[i + 1];
    if (quote !== "'" && ch === (powershell ? "`" : "\\")) {
      if (!next) return;
      if (!powershell && quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) {
        word += ch;
      } else {
        i++;
        if (next !== "\n") { word += next; started = true; }
      }
    } else if (quote) {
      if (ch !== quote) word += ch;
      else if (powershell && next === quote) { word += ch; i++; }
      else {
        if (quote === "`") word += ch;
        quote = "";
      }
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      started = true;
      if (ch === "`") word += ch;
    } else if (ch === "(" || groupDepth) {
      // A subshell/expression is opaque. Its connectors cannot start top-level segments.
      word += ch;
      started = true;
      if (ch === "(") groupDepth++;
      if (ch === ")") groupDepth--;
    } else if (ch === ";" || ch === "|" || ch === "\n" || (ch === "&" && next === "&")) {
      endWord();
      if (args.length) yield args;
      args = [];
      if ((ch === "|" || ch === "&") && next === ch) i++;
    } else if (/\s/u.test(ch)) {
      endWord();
    } else if (ch === "&" && !started && !args.length) {
      continue; // PowerShell call operator
    } else if (ch === "#" && !started) {
      const newline = command.indexOf("\n", i);
      i = newline < 0 ? command.length : newline - 1;
    } else if (ch === ")" || (ch === "<" && next === "<")) {
      return;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote || groupDepth) return;
  endWord();
  if (args.length) yield args;
}

const batOptionsWithValues = ["--theme", "--language", "--style", "--terminal-width", "--tabs", "--line-range", "--map-syntax"];
const readerFlags: ReadonlyMap<string, readonly string[]> = new Map([
  ["cat", []], ["more", []],
  ["bat", batOptionsWithValues], ["batcat", batOptionsWithValues],
  ["less", ["-p", "-P", "-x", "-y", "-z", "-j", "--pattern", "--prompt", "--tabs", "--shift", "--jump-target"]],
  ["head", ["-n", "-c"]], ["tail", ["-n", "-c"]],
  ["nl", ["-s", "-w", "-v", "-i", "-b"]],
  ["awk", ["-F", "-v", "-f", "--field-separator", "--assign", "--file"]],
]);

// Windows reads of Chinese skill text commonly pass -Encoding; line limits are equally common.
const getContentValueFlags = new Set(["-totalcount", "-head", "-first", "-tail", "-last", "-encoding", "-readcount", "-delimiter"]);

// Redirections such as `2>/dev/null`, `2>&1` or `> out.txt` are not operands of the command.
function withoutRedirections(args: string[]): string[] {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^(?:\d|\*)?(?:>>?|<)$/u.test(arg)) { i++; continue; }
    if (/^(?:\d|\*)?(?:>>?|<)/u.test(arg)) continue;
    operands.push(arg);
  }
  return operands;
}

function readPath(name: string, args: string[]): string | undefined {
  if (name === "sed") {
    // Only sed's quiet, numeric print-range form reads a document for attribution.
    const [quiet, ...rest] = args;
    if (quiet !== "-n") return;
    if (rest[0] === "-e" || rest[0] === "--expression") rest.shift();
    if (rest.length === 2 && /^\d+(?:,\d+)?p$/u.test(rest[0]!)) return rest[1];
    return;
  }
  if (["get-content", "gc", "type"].includes(name)) {
    let path: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!, flag = arg.toLowerCase();
      if (getContentValueFlags.has(flag)) {
        if (args[i + 1] === undefined) return;
        i++;
        continue;
      }
      if (flag === "-raw" || flag === "-force") continue;
      if (flag === "-path" || flag === "-literalpath") {
        if (!args[i + 1] || args[i + 1]!.startsWith("-")) return;
        continue;
      }
      if (flag.startsWith("-") || path !== undefined) return;
      path = arg;
    }
    return path;
  }
  const flags = readerFlags.get(name);
  if (!flags) return;
  let operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      operands = operands.concat(args.slice(i + 1));
      break;
    }
    if (flags.includes(arg)) i++;
    else if (!arg.startsWith("-")) operands.push(arg);
  }
  if (name === "awk" && !args.includes("-f") && !args.includes("--file")) operands.shift();
  return operands.length === 1 ? operands[0] : undefined;
}

function executable(token: string, shell: StatisticsShell): string {
  const path = shell === "powershell" ? token.replaceAll("\\", "/") : token;
  return basename(path).toLowerCase().replace(/\.exe$/u, "");
}

function scriptPath(name: string, token: string, args: string[], shell: StatisticsShell): string | undefined {
  let index = 0;
  if (name === "uv" && args[0]?.toLowerCase() === "run") {
    index = 1;
    while (args[index]?.startsWith("-")) {
      if (["-m", "--module"].includes(args[index]!)) return;
      index += ["--python", "--with", "--project"].includes(args[index]!) ? 2 : 1;
    }
    const runner = executable(args[index] ?? "", shell);
    if (runners.has(runner)) { name = runner; index++; }
  } else if (name === "npx" && args[0]?.toLowerCase() === "tsx") {
    index = 1;
  } else if (!runners.has(name)) {
    return scriptExtension.test(token) && /[/\\]/u.test(token) ? token : undefined;
  }
  for (; index < args.length; index++) {
    const arg = args[index]!;
    if (pythonRunners.has(name)) {
      if (/^-[bBdEhiIOPqRsSuvVx]*[mc]/u.test(arg)) return;
      if (arg === "-X" || arg === "-W") { index++; continue; }
    }
    if (powerShells.has(name)) {
      const flag = arg.toLowerCase();
      if (["-c", "-command", "-encodedcommand"].includes(flag)) return;
      if (flag === "-executionpolicy") { index++; continue; }
    }
    if (name === "node" || name === "npx") {
      if (["-e", "--eval", "--print", "-p"].includes(arg)) return;
      if (["-r", "--require", "--import", "--loader"].includes(arg)) { index++; continue; }
    }
    if ((name === "ruby" || name === "perl") && (arg === "-e" || (name === "perl" && arg === "-E"))) return;
    if (arg.startsWith("-")) continue;
    if (name === "deno" && arg === "run") continue;
    return scriptExtension.test(arg) ? arg : undefined;
  }
}

/** Matches at most one skill per call, using the locations from this turn's snapshot. */
export class SkillCommandMatcher {
  private scriptDirectories?: ReadonlyMap<string, string>;

  constructor(private readonly locations: Readonly<Record<string, string>>) {}

  match(command: string, cwd: string, workspace: string, shell: StatisticsShell): SkillMatch | undefined {
    return this.matchSegments(command, resolvePath(workspace, cwd.trim(), shell), shell, true);
  }

  private scriptSkill(path: string): string | undefined {
    this.scriptDirectories ??= new Map(Object.entries(this.locations).map(([manifest, skill]) =>
      [skillPathKey(join(dirname(manifest), "scripts")), skill]));
    let directory = dirname(skillPathKey(path));
    while (directory !== dirname(directory)) {
      const skill = this.scriptDirectories.get(directory);
      if (skill) return skill;
      directory = dirname(directory);
    }
  }

  private matchSegments(command: string, directory: string, shell: StatisticsShell, unwrap: boolean): SkillMatch | undefined {
    for (const [token, ...words] of segments(command, shell)) {
      if (!token) continue;
      const args = withoutRedirections(words);
      const name = executable(token, shell);
      if (["cd", "set-location", "sl", "pushd"].includes(name)) {
        const path = args[0] === "--" || ["-path", "-literalpath"].includes(args[0]?.toLowerCase() ?? "")
          ? args[1] : args[0];
        if (path) directory = resolvePath(directory, path, shell);
        continue;
      }
      const innerShell = posixShells.has(name) ? "posix" : powerShells.has(name) ? "powershell" : undefined;
      if (innerShell) {
        const flag = innerShell === "posix" ? args.findIndex(arg => ["-c", "-lc"].includes(arg))
          : args.findIndex(arg => ["-command", "-c"].includes(arg.toLowerCase()));
        if (flag >= 0 && args.slice(0, flag).every(arg => arg.startsWith("-"))) {
          const inner = args[flag + 1];
          const match = unwrap && inner && this.matchSegments(inner, directory, innerShell, false);
          if (match) return match;
          continue;
        }
      }
      if (/^lxeskill(?:\.cmd)?$/iu.test(token)) return { command: ["lxeskill", ...args] };
      const read = readPath(name, args);
      if (read) {
        const skill = this.locations[skillPathKey(resolvePath(directory, read, shell))];
        if (skill) return { skill };
      }
      const script = scriptPath(name, token, args, shell);
      if (script) {
        const skill = this.scriptSkill(resolvePath(directory, script, shell));
        if (skill) return { skill };
      }
    }
  }
}
