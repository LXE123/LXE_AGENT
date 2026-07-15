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

Then run:

```powershell
bun run desktop:dist:win
```

The build first validates `electron-builder.yml` against the schema bundled
with the pinned electron-builder version. The same fast check is available on
every development platform and is included in `bun run verify`:

```powershell
bun run desktop:validate:config
```

Only after that check passes does the Windows command prepare or reuse the
managed runtime, inject it into the build subprocess environment, rebuild the
current LXE wheel, compile `agent-cli.exe`, install the wheel into the staged
private Python, stage the remaining resources, and create the NSIS installer.

`-Offline` also applies to the wheel build. A prior online build must have
populated the persistent uv cache with the pinned Hatchling build backend;
missing build cache causes a clear failure without modifying the last valid
base runtime.

`desktop:resources` installs the wheel with `--offline --no-deps --reinstall`,
runs `python -I -m lxeskill list`, and fails unless all 28 commands are present.
The final resource tree must not contain `runtime/lxeskill`; the module lives in
the private Python site-packages and is recorded in the SHA-256 manifest. A
small readiness marker records the successful 28-command smoke and wheel hash;
desktop health requires the Python executable, module file, and marker. Only
Git-tracked project resources are copied, so local `.env`, authentication,
sessions, and business artifacts cannot leak into the installer.

Authenticode signing uses electron-builder's standard `CSC_LINK` and
`CSC_KEY_PASSWORD` environment variables. Unsigned output is intended only for
internal test machines.
