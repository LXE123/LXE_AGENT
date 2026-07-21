# Electron desktop packaging

The Windows desktop build keeps the React Dashboard as the Electron Renderer,
runs the Gateway in Electron Main, and launches one private compiled
`agent-cli.exe` over stdin/stdout JSON Lines.

## Managed build inputs

Run the complete installer build on Windows x64. The managed native runtimes
and NSIS package are not cross-compiled from macOS or Linux.

Prepare the pinned private runtime with:

```powershell
bun run desktop:runtime:win
```

The first run downloads Node 22.22.2, Python 3.12.10, uv 0.11.19,
ripgrep 15.1.0, Playwright Chromium, and the pinned DingTalk/Lark npm packages.
Playwright is installed with `--no-shell`; headed and headless automation both
use the full browser through the `chromium` channel instead of carrying the
separate Chromium headless shell.
Validated downloads and a complete runtime image are cached under
`build/desktop-runtime-cache/win32-x64`, so a later build can be reconstructed
offline:

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File scripts/prepare-desktop-runtime.ps1 -Offline -Force
```

Set `LXE_DESKTOP_RUNTIME_ROOT` and `LXE_DESKTOP_CACHE_ROOT` to place the large
runtime and cache on another drive. Explicit `-RuntimeRoot` and `-CacheRoot`
parameters take precedence. The preparer never installs into system Node,
system Python, or the repository `.venv`.

The generated `build/desktop-runtime-inputs.json` supplies these resource
staging paths automatically:

- `LXE_DESKTOP_NODE_ROOT`: Node with `node.exe`, npm/npx, and the pinned DingTalk
  and Lark CLI packages.
- `LXE_DESKTOP_PYTHON_ROOT`: relocatable Python 3.12.10 distribution.
  Production dependencies are exported from `uv.lock` and installed into the
  private copy with user site-packages disabled.
- `LXE_DESKTOP_UV_PATH`: `uv.exe`.
- `LXE_DESKTOP_RG_PATH`: `rg.exe`.
- `LXE_DESKTOP_PLAYWRIGHT_ROOT`: Playwright Chromium browser directory.

The wrapper separately builds the current repository as a wheel on every run.
It uses the persistent runtime `uv-cache`, and passes the resulting wheel to
resource staging through the internal `LXE_DESKTOP_PROJECT_WHEEL` input. The
wheel is never stored in the base runtime image, so rebuilding cannot reuse
stale LXE source.

These five environment variables remain supported as per-field overrides for
custom build infrastructure. `LXE_DESKTOP_RUNTIME_DESCRIPTOR` can point resource
staging at a non-default descriptor.

For daily packaged-layout validation without NSIS compression, run:

```powershell
bun run desktop:pack:win
```

This writes `dist/desktop-unpacked/win-unpacked/LXE Agent.exe`, enforces the same
resource size budgets, and runs the packaged preload/IPC smoke. It does not
exercise installer directory selection, shortcuts, upgrade preservation,
uninstall behavior, or WireGuard provisioning.

For a release installer, run:

```powershell
bun run desktop:dist:win
```

The build first validates `electron-builder.yml` against the schema bundled
with the pinned electron-builder version. The same fast check is available on
every development platform and is included in `bun run verify`:

```powershell
bun run desktop:validate:config
```

Only after that check passes does the shared Windows wrapper prepare or reuse
the managed runtime, inject it into the build subprocess environment, rebuild
the current LXE wheel, compile `agent-cli.exe`, install the wheel into the staged
private Python, and stage the remaining resources. The unpacked route stops
after Electron Builder creates the runnable directory; the release route also
creates the NSIS installer. Both routes print per-stage timings.

The managed build image is intentionally larger than the installed runtime.
It retains npm/npx, the npm content cache, and uv so that an offline build can
be reconstructed. Resource staging keeps `node.exe`, `python.exe`, pip, the
three pinned Node CLIs, ripgrep, and the production Python packages, but it does
not copy npm/npx, `npm-cache`, or `uv.exe` into the installer. The DWS package's
post-install archives are also omitted after its native executable and shared
skills have been validated.

The packaged Playwright Python binding uses the private Node 22 executable via
`PLAYWRIGHT_NODEJS_PATH`; its second driver-local `node.exe` is removed. Both
Electron and Playwright Chromium keep only `en-US` and `zh-CN` locale packs.
Agent shell commands can still run Node, Python, pip, lxeskill, DWS, Lark CLI,
and Whiteboard CLI. The legacy skill form `uv run --frozen python ...` is
normalized to the managed Python executable before the shell is spawned.

`-Offline` also applies to the wheel build. A prior online build must have
populated the persistent uv cache with the pinned Hatchling build backend;
missing build cache causes a clear failure without modifying the last valid
base runtime.

> 2026-07-16：固定 28 命令门禁已由
> [物流服务退役记录](20260716-retire-logistics-service.md) 取代；打包现在比较源码与 wheel 的完整命令集合。

`desktop:resources` installs the wheel with `--offline --no-deps --reinstall`,
runs `python -I -m lxeskill list`, and fails unless its command set exactly matches
the current source catalog.
The final resource tree must not contain `runtime/lxeskill`; the module lives in
the private Python site-packages. A small readiness marker records the successful
catalog smoke; desktop health requires the Python executable, module file, and marker. Only
Git-tracked project resources are copied, so local `.env`, authentication,
sessions, and business artifacts cannot leak into the installer.

> 2026-07-21：逐文件资源 manifest、打包前后 SHA-256 对比和启动时全量完整性扫描已经废弃。
> 资源准备改为先清空 staging，再只复制构造式白名单允许的来源文件。

After electron-builder creates `win-unpacked`,
`scripts/report-desktop-resource-sizes.ts` writes the report beside the selected
output root: `dist/desktop-unpacked/desktop-resource-sizes.json` for the fast
route or `dist/desktop/desktop-resource-sizes.json` for the release route. It
reports logical bytes and file counts for Electron, Node, Python, Playwright,
agent-cli, tools, Dashboard, and project resources. Both Windows builds fail
when the managed runtime exceeds 950 MiB or the complete unpacked application
exceeds 1.30 GiB.

## Windows size baseline

The optimized 2026-07-16 Windows x64 build produced these measured results:

| Component | Logical size |
| --- | ---: |
| Installed application | 1,207.24 MiB |
| `win-unpacked` | 1,207.08 MiB |
| Managed runtime | 884.29 MiB |
| Node runtime and CLI packages | 215.28 MiB |
| Python runtime and packages | 209.43 MiB |
| Playwright browser files | 356.47 MiB |
| Compiled agent-cli | 99.05 MiB |
| Electron and top-level files | 301.57 MiB |
| NSIS installer | 354.45 MiB |

The previous installed application measured 1,832.07 MiB. The optimized
installation is 624.83 MiB smaller, a 34.1% reduction. The generated report
confirmed zero packaged bytes for `runtime/uv`, `runtime/node/npm-cache`, and
the Playwright driver-local Node executable. The unpacked, NSIS, and actual
installed application all passed the packaged preload/IPC health probe.

Authenticode signing uses electron-builder's standard `CSC_LINK` and
`CSC_KEY_PASSWORD` environment variables. Unsigned output is intended only for
internal test machines.

## Platform quality gates

Run `bun run verify:platform:win` on Windows x64. It covers the production
boundary, the complete Bun and Python suites, all workspace type checks, the
wheel, native Agent CLI, Dashboard, Gateway, Electron build, and the complete
NSIS pipeline. It deliberately invokes `desktop:dist:win`, not the faster
unpacked route.

Run `bun run verify:platform:mac` on macOS. It runs the same source, test, type,
wheel, native Agent CLI, Dashboard, Gateway, Electron build, and Builder schema
checks. The command deliberately does not produce a macOS application bundle:
the managed private runtime and release signing/notarization pipeline are
currently Windows-only. A macOS DMG must not be treated as supported until
equivalent pinned Node, Python, uv, ripgrep, Playwright, wheel staging, signing,
and installed-app smoke coverage exists.

Target-platform path tests inject Windows, macOS, and Linux explicitly. Code
that accepts an injected platform must use `node:path`'s matching `win32` or
`posix` implementation rather than host `join`, `resolve`, or `delimiter`.
