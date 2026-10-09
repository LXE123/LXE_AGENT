/**
 * The windows-acl confinement runner: the argv-prefix wrapper the sandbox
 * seam spawns in place of the caller's command. It creates the
 * WRITE_RESTRICTED token with the workspace write-SID allowlist, spawns the
 * wrapped argv under it with the CALLER'S stdio inherited (bytes flow
 * straight through), mirrors the child's exit code, and revokes its temp
 * grant on exit (workspace ACEs stay standing as the reuse cache).
 *
 * Stable argv contract (the seam builds it; a native-exe replacement would
 * keep the same contract):
 *   [node, runner.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write>,
 *    ['--write-sid', <S-1-4-…>,
 *     '--temp-write-sid', <S-1-4-…>], '--', <argv...>]
 *
 * Modes:
 *  - workspace-write: the workspace and temp directories carry distinct
 *    capability-SID Write grants; other ACL-addressable writes are denied
 *    except for the documented Everyone and hard-link boundaries.
 *  - read-only: no capability-SID grants; the restricting list carries no
 *    capability SID, so a standing grant ACE from an earlier
 *    workspace-write period stays inert. BOTH modes drop Authenticated Users
 *    (CIM unavailable — documented in README) and INTERACTIVE/LOCAL (the
 *    Public tree writes are denied); the two lists share the keep-alive group
 *    (logon SID, EVERYONE) and differ only by the capabilities.
 *
 * `--write-sid` + `--temp-write-sid`: the seam's grant contract — the
 * CALLER has already materialized distinct workspace and private-temp ACEs
 * and owns their revocation, so the runner neither grants nor revokes
 * (`manageDacls: false`). Both values are checked against their owning paths.
 * Without the pair (standalone/agentless use), workspace-write treats
 * `--temp` as a ROOT, creates a random private child directory, derives its
 * own temp SID, and removes that directory after the child exits. In both
 * flows the runner rewrites TMP/TEMP in its OWN environment to the private
 * directory before spawning; the child inherits that block (`lpEnvironment`
 * NULL; an explicit block through koffi trips ERROR_INVALID_PARAMETER in
 * CreateProcessAsUserW, verified empirically). Read-only leaves the ambient
 * temp entries untouched (writes there are denied anyway).
 *
 * Failure contract: every runner-side failure (bad args, missing
 * directories, token/grant/spawn errors) prints `windows-acl-run: <detail>`
 * to stderr and exits 127 — the seam's RUNNER_FAILURE_RULES matches that
 * signature. The child is NEVER spawned unrestricted.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/runner
 */

import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve, win32 as winPaths } from 'node:path'

import { win32 } from './acl/ffi.ts'
import { AclSandbox, assertTempRootOutsideWorkspace } from './acl/index.ts'
import { AclWriteGrant } from './acl/grant.ts'
import { managedStateWriteSid, tempWriteSid, workspaceWriteSid } from './acl/workspace-sid.ts'
import { managedPythonStateRoots } from '../../src/permissions/managed-python-state.ts'

const RUNNER_SIGNATURE = 'lxe-windows-acl-run'
const RUNNER_FAILURE_EXIT = 127

class RunnerFailure extends Error {}

/** Print the runner-failure signature line and unwind. */
function fail(detail: string): never {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`)
  throw new RunnerFailure(detail)
}

interface ParsedArgs {
  workspace: string
  temp: string
  dataRoot: string
  mode: 'read-only' | 'workspace-write'
  writeSid: string | undefined
  tempWriteSid: string | undefined
  stateWriteSid: string | undefined
  command: string
  args: string[]
}

function parseArgs(raw: string[]): ParsedArgs {
  let workspace: string | undefined
  let temp: string | undefined
  let dataRoot: string | undefined
  let mode: string | undefined
  let writeSid: string | undefined
  let parsedTempWriteSid: string | undefined
  let stateWriteSid: string | undefined
  let index = 0
  for (; index < raw.length; index++) {
    const token = raw[index]
    if (token === '--') {
      index++
      break
    }
    index++
    const value = raw[index]
    if (value === undefined) fail(`missing value after ${token}`)
    switch (token) {
      case '--workspace': workspace = value; break
      case '--temp': temp = value; break
      case '--data-root': dataRoot = value; break
      case '--mode': mode = value; break
      case '--write-sid': writeSid = value; break
      case '--temp-write-sid': parsedTempWriteSid = value; break
      case '--state-write-sid': stateWriteSid = value; break
      default: fail(`unknown argument: ${token}`)
    }
  }
  if (workspace === undefined) fail('missing --workspace')
  if (temp === undefined) fail('missing --temp')
  if (dataRoot === undefined) fail('missing --data-root')
  if (mode !== 'read-only' && mode !== 'workspace-write') fail(`unknown mode: ${String(mode)}`)
  const argv = raw.slice(index)
  const command = argv[0]
  if (command === undefined) fail('missing command after --')
  return { workspace, temp, dataRoot, mode, writeSid, tempWriteSid: parsedTempWriteSid, stateWriteSid, command, args: argv.slice(1) }
}

function managedStateDirectories(dataRoot: string): string[] {
  const root = realpathSync.native(resolve(dataRoot))
  return managedPythonStateRoots(root).map((candidate) => {
    const path = realpathSync.native(candidate)
    const relative = winPaths.relative(root.toLowerCase(), path.toLowerCase())
    if (!relative || winPaths.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${winPaths.sep}`)) {
      fail(`managed state path escaped --data-root: ${path}`)
    }
    requireDirectory('managed state directory', path)
    return path
  })
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`)
  }
}

async function main(): Promise<number> {
  const action = process.argv[2]
  if (action === '--prepare-session' || action === '--release-session') {
    const workspace = process.argv[3], temp = process.argv[4], dataRoot = process.argv[5]
    if (!workspace || !temp || !dataRoot || process.argv.length !== 6) fail('session operation requires workspace, temporary directory, and data root')
    requireDirectory('workspace', workspace)
    requireDirectory('temporary directory', temp)
    requireDirectory('data root', dataRoot)
    const stateDirs = managedStateDirectories(dataRoot)
    assertTempRootOutsideWorkspace(workspace, temp)
    await win32()
    const writeSid = workspaceWriteSid(workspace), privateSid = tempWriteSid(temp), stateSid = managedStateWriteSid(dataRoot)
    const workspaceGrant = AclWriteGrant.create(writeSid)
    try {
      const temporaryGrant = AclWriteGrant.create(privateSid)
      try {
        const stateGrant = AclWriteGrant.create(stateSid)
        try {
        if (action === '--prepare-session') {
          workspaceGrant.add(workspace, true)
          // The Bun host owns revocation, including failure cleanup.
          temporaryGrant.add(temp, true)
          for (const path of stateDirs) stateGrant.add(path, true)
          process.stdout.write(JSON.stringify({ writeSid, tempWriteSid: privateSid, managedStateWriteSid: stateSid }))
        } else temporaryGrant.revoke(temp)
        } finally { stateGrant.dispose() }
      } finally { temporaryGrant.dispose() }
    } finally { workspaceGrant.dispose() }
    return 0
  }
  const parsed = parseArgs(process.argv.slice(2))
  // Both directories are validated in both modes: a provider bug that passes
  // a bogus root must fail loudly at the runner boundary, never mid-child.
  requireDirectory('--workspace', parsed.workspace)
  requireDirectory('--temp', parsed.temp)
  requireDirectory('--data-root', parsed.dataRoot)

  const seamManaged = parsed.writeSid !== undefined || parsed.tempWriteSid !== undefined
  if (parsed.mode === 'read-only' && seamManaged) {
    fail('read-only does not accept --write-sid or --temp-write-sid')
  }
  if (parsed.mode === 'read-only' && parsed.stateWriteSid !== undefined) fail('read-only does not accept --state-write-sid')
  if (parsed.stateWriteSid !== undefined && parsed.stateWriteSid !== managedStateWriteSid(parsed.dataRoot)) {
    fail('--state-write-sid does not match --data-root')
  }
  if (parsed.mode === 'workspace-write' && (parsed.writeSid === undefined) !== (parsed.tempWriteSid === undefined)) {
    fail('workspace-write requires --write-sid and --temp-write-sid together')
  }
  if (parsed.mode === 'workspace-write') {
    assertTempRootOutsideWorkspace(parsed.workspace, parsed.temp)
  }

  const api = await win32()
  // Ignore this process's own CTRL+C: the confined child (same console) keeps
  // handling its own; the runner must survive to revoke grants and mirror the
  // child's exit code.
  if (api.setConsoleCtrlHandler(null, 1) === 0) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`)
  }

  let ownedTempDir: string | undefined
  let sandbox: AclSandbox | undefined
  let initialized = false
  try {
    let privateTempDir: string | null = null
    let writeSid: string | undefined
    let privateTempSid: string | undefined
    let stateDirs: string[] | undefined
    if (parsed.mode === 'workspace-write') {
      writeSid = workspaceWriteSid(parsed.workspace)
      if (seamManaged) {
        if (parsed.writeSid !== writeSid) fail('--write-sid does not match --workspace')
        privateTempDir = parsed.temp
        privateTempSid = tempWriteSid(privateTempDir)
        if (parsed.tempWriteSid !== privateTempSid) fail('--temp-write-sid does not match --temp')
      } else {
        ownedTempDir = mkdtempSync(join(parsed.temp, 'exec-'))
        privateTempDir = ownedTempDir
        privateTempSid = tempWriteSid(privateTempDir)
      }
    }
    if (parsed.stateWriteSid !== undefined) stateDirs = managedStateDirectories(parsed.dataRoot)
    sandbox = new AclSandbox({
      writableDirs: parsed.mode === 'workspace-write' ? [parsed.workspace] : [],
      tempDir: privateTempDir,
      mode: parsed.mode,
      ...writeSid === undefined ? {} : { writeSid },
      ...privateTempSid === undefined ? {} : { tempWriteSid: privateTempSid },
      ...parsed.stateWriteSid === undefined ? {} : {
        managedStateWriteSid: parsed.stateWriteSid,
        managedStateDirs: stateDirs,
      },
      manageDacls: !seamManaged,
    })
    await sandbox.init()
    initialized = true

    if (privateTempDir !== null) {
      if (api.setEnvironmentVariableW('TMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TMP failed (Win32 ${api.getLastError()})`)
      }
      if (api.setEnvironmentVariableW('TMPDIR', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TMPDIR failed (Win32 ${api.getLastError()})`)
      }
      if (api.setEnvironmentVariableW('TEMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TEMP failed (Win32 ${api.getLastError()})`)
      }
    }

    const child = sandbox.spawn({
      command: parsed.command,
      args: parsed.args,
      stdio: 'inherit',
    })
    const result = await child.wait()
    return result.exitCode
  } finally {
    // Cleanup failures must not mask the child's exit code: report and keep going.
    if (initialized) {
      try {
        sandbox?.dispose()
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (ownedTempDir !== undefined) {
      try {
        rmSync(ownedTempDir, { recursive: true, force: true })
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
}

main().then(
  (exitCode) => {
    // Exit-code mirroring is full-width on Windows, verified empirically on
    // this machine (Windows 11 build 26200, Node 24): a child that exits
    // with the NTSTATUS 0xC0000005 (STATUS_ACCESS_VIOLATION) is read back
    // by GetExitCodeProcess as the uint32 3221225477, and after
    // process.exitCode = 3221225477 the parent observes exactly
    // 3221225477 (spawnSync status). PowerShell's $LASTEXITCODE and cmd
    // print the signed view (-1073741819), but no truncation or masking
    // happens anywhere in the chain — the mirror contract holds for the
    // full 32-bit range, so no re-mapping is needed.
    process.exitCode = exitCode
  },
  (error: unknown) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(`${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = RUNNER_FAILURE_EXIT
  },
)
